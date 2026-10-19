#!/usr/bin/env node
// 把上游页面引用的外部静态资源（Google Fonts、jsDelivr、cdnjs、unpkg）镜像到本地，
// 写入 content/dist/assets/vendor 与 content/dist/assets/fonts，并生成 URL → 本地路径映射表。
//
// 背景：WebUtils 的 1100+ 个工具页在 <head> 里引用 fonts.googleapis.com（中国大陆不可达），
// 部分工具还从 cdn.jsdelivr.net 加载 marked/chart.js/pdf.js 等库（本机网络实测连接失败）。
// 不镜像就会出现「字体请求挂起、依赖库 404」的真实故障，因此构建时统一落到本地。
//
// 取源策略（本机网络实测）：
//   cdn.jsdelivr.net  → 不可达，改从 registry.npmjs.org 取该包的 tarball（版本与校验和都留痕）
//   unpkg.com         → 可用但高并发时失败率高，只作兜底
//   cdnjs / gstatic   → 直连可用
//
// 用法：node tools/mirror-assets.mjs <distDir> <lockFile>

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import dns from 'node:dns';
import path from 'node:path';

// 本容器没有 IPv6 路由：DNS 解析优先 IPv4，避免 fetch 命中 AAAA 记录后 ENETUNREACH
dns.setDefaultResultOrder('ipv4first');

const DIST = process.argv[2] || 'content/dist';
const LOCK_FILE = process.argv[3] || '.build/vendor-lock.json';
const NPM_CACHE = '.build/npm-cache';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const EXT_RE = /https:\/\/(?:cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\/[^"'\s)>]+/g;

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

async function fetchWithRetry(url, init, tries = 5) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      lastErr = err;
      await sleep(1200 * (i + 1));
    }
  }
  throw lastErr;
}

// 整个「取流 + 读 body」都放进重试：cdnjs 偶发在读 body 时 'TypeError: terminated'，
// 只重试 fetch() 本身抓不到这种失败。
async function fetchBuf(url, { binary = true, accept } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      // 每次尝试都要有硬超时：CDN 被黑洞时会一直挂着，5 次重试就变成十几分钟
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
        headers: { 'User-Agent': UA, ...(accept ? { Accept: accept } : {}) },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new Error(`empty body for ${url}`);
      if (binary && /^\s*<!doctype html/i.test(buf.subarray(0, 200).toString('utf8')) && !/\.(html|css)$/i.test(url)) {
        throw new Error(`html error page for ${url}`);
      }
      return { buf, finalUrl: res.url };
    } catch (err) {
      lastErr = err;
      await sleep(1200 * (attempt + 1));
    }
  }
  throw lastErr;
}

// 跳过镜像产物目录：assets/vendor 与 assets/fonts 是自己刚写进去的文件，
// 再次扫描会把它们的 sourceMappingURL 之类当成本站引用，造成无意义的重复镜像。
const SKIP_DIRS = new Set(['vendor', 'fonts']);
function walk(dir, out = [], isRoot = true) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!isRoot && SKIP_DIRS.has(name) && /assets$/.test(path.basename(dir))) continue;
      walk(p, out, false);
    } else if (/\.(html|js|css)$/i.test(name)) out.push(p);
  }
  return out;
}

// ── 1. 收集外部引用 ────────────────────────────────────────────────────────────
const files = walk(DIST);
const urls = new Set();
for (const f of files) {
  const txt = readFileSync(f, 'utf8');
  for (const m of txt.matchAll(EXT_RE)) urls.add(m[0].replace(/&amp;/g, '&'));
}
// 模板字符串与省略号占位（docs 里的示例代码）不是真实资源，排除且不计入失败
for (const u of [...urls]) if (u.includes('${') || /\/\.\.\.$/.test(u)) urls.delete(u);
console.log(`扫描 ${files.length} 个文件，外部资源 URL ${urls.size} 个`);

const fontCssUrls = [...urls].filter((u) => u.startsWith('https://fonts.googleapis.com/'));
const assetUrls = [...urls].filter((u) => !u.startsWith('https://fonts.googleapis.com/') && !u.startsWith('https://fonts.gstatic.com/'));

const lock = {
  generatedAt: new Date().toISOString(),
  fonts: { css: '/assets/fonts/fonts.css', urls: {}, files: [] },
  assets: {},
  dynamic: {},
};
for (const u of fontCssUrls) lock.fonts.urls[u] = lock.fonts.css;

// ── 2. Google Fonts：合并成一份本地 CSS ───────────────────────────────────────
const families = [
  'Inter:wght@400;500;600;700',
  'JetBrains Mono:wght@400;500;600;700',
  'Space Grotesk:wght@400;500;600;700',
];
const fontDir = path.join(DIST, 'assets/fonts');
mkdirSync(path.join(fontDir, 'files'), { recursive: true });

let css = '/* WebUtils 本地字体（构建时镜像自 Google Fonts，保持上游同一字体与字重） */\n';
for (const fam of families) {
  const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fam.split(':')[0])}:wght@${fam.split('wght@')[1]}&display=swap`.replace(/%20/g, '+');
  const { buf } = await fetchBuf(url, { binary: false });
  css += `\n/* ${fam} */\n` + buf.toString('utf8');
}
const gstaticRe = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g;
const fontFiles = new Set();
for (const m of css.matchAll(gstaticRe)) fontFiles.add(m[1]);
// 本地文件名要能当静态文件路径用：Google 的旧版字体地址形如
// https://fonts.gstatic.com/l/font?kit=...&skey=...&v=v22，直接用最后一段会得到
// 「font?kit=...」这种带查询串的文件名，静态路由会把 ? 之后当 query，取不到文件
// （表现为控制台 "Failed to decode downloaded font"）。因此清洗文件名并补短哈希去重。
const STYLE_EXT_RE = /\.(woff2|woff|ttf|otf|eot)$/i;
const localFontName = (url) => {
  const parsed = new URL(url);
  const base = decodeURIComponent(parsed.pathname.split('/').pop() || 'font');
  const extMatch = STYLE_EXT_RE.exec(base);
  const stem = (extMatch ? base.slice(0, -extMatch[0].length) : base).replace(/[^A-Za-z0-9._-]/g, '_');
  const ext = extMatch ? extMatch[0].toLowerCase() : '.woff2';
  const hash = parsed.search ? '-' + createHash('sha1').update(parsed.search).digest('hex').slice(0, 10) : '';
  return stem + hash + ext;
};
const fontNameMap = new Map();
for (const u of fontFiles) fontNameMap.set(u, localFontName(u));
css = css.replace(gstaticRe, (_, u) => `url(/assets/fonts/files/${fontNameMap.get(u) || localFontName(u)})`);
for (const u of fontFiles) {
  const name = fontNameMap.get(u) || localFontName(u);
  const { buf } = await fetchBuf(u);
  writeFileSync(path.join(fontDir, 'files', name), buf);
  lock.fonts.files.push({ url: u, local: `assets/fonts/files/${name}`, sha256: sha256(buf), bytes: buf.length });
}
writeFileSync(path.join(fontDir, 'fonts.css'), css);
console.log(`字体：${families.length} 个字族，${fontFiles.size} 个 woff2 → assets/fonts/`);

// ── 3. 其余 CDN 资源 ──────────────────────────────────────────────────────────
const localPathFor = (u) => {
  const parsed = parseUrl(u);
  return parsed ? `/assets/vendor/${parsed.host}${parsed.pathname}` : '';
};

// jsDelivr 的路径是「自动压缩」的产物（xxx.min.js），npm 包里常常只有未压缩版
const PATH_OVERRIDES = {
  'marked/marked.min.js': 'marked/lib/marked.umd.js',
  'marked@12.0.0/marked.min.js': 'marked/lib/marked.umd.js',
};
const demin = (p) => p.replace(/\.min(\.js|\.css)$/, '$1');

let npmMetaCache = new Map();
async function npmMeta(pkg) {
  if (npmMetaCache.has(pkg)) return npmMetaCache.get(pkg);
  const { buf } = await fetchBuf(`https://registry.npmjs.org/${encodeURIComponent(pkg).replace('%40', '@')}`, { binary: false });
  let meta;
  try {
    meta = JSON.parse(buf.toString('utf8'));
  } catch (err) {
    throw new Error(`npm 元数据不是合法 JSON（${pkg}）：${err.message}`);
  }
  npmMetaCache.set(pkg, meta);
  return meta;
}

function extractFromTarball(tgz, member) {
  const res = spawnSync('tar', ['-xzOf', tgz, member], { maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0 || !res.stdout || res.stdout.length === 0) return null;
  return res.stdout;
}

async function fromNpm(pkgSpec, filePath) {
  // pkgSpec 形如 chart.js@4.4.1 或 @picocss/pico@2 或 marked
  const at = pkgSpec.startsWith('@') ? pkgSpec.lastIndexOf('@') : pkgSpec.indexOf('@');
  const name = at > 0 ? pkgSpec.slice(0, at) : pkgSpec;
  const wanted = at > 0 ? pkgSpec.slice(at + 1) : '';
  const meta = await npmMeta(name);
  let version = wanted && meta.versions?.[wanted] ? wanted : null;
  if (!version) {
    // 允许范围写法（@2 / @3）：取满足主版本的最高发布版本
    const major = wanted.replace(/^[\^~]/, '').split('.')[0];
    const candidates = Object.keys(meta.versions || {}).filter((v) => (major ? v.split('.')[0] === major : true));
    version = candidates.length ? candidates[candidates.length - 1] : meta['dist-tags']?.latest;
  }
  if (!version) throw new Error(`npm 包 ${name} 没有可用版本`);
  const info = meta.versions[version];
  mkdirSync(NPM_CACHE, { recursive: true });
  const tgz = path.join(NPM_CACHE, `${name.replace('/', '__')}-${version}.tgz`);
  if (!existsSync(tgz)) {
    const { buf } = await fetchBuf(info.dist.tarball);
    writeFileSync(tgz, buf);
  }
  const members = [
    `package/${filePath}`,
    `package/${demin(filePath)}`,
    `package/dist/${filePath}`,
    `package/dist/${demin(filePath)}`,
    `package/build/${filePath}`,
  ];
  const override = PATH_OVERRIDES[`${name}/${filePath}`];
  if (override) members.push(`package/${override.replace(`${name}/`, '')}`);
  for (const m of members) {
    const buf = extractFromTarball(tgz, m);
    if (buf) {
      return {
        buf,
        resolvedUrl: `${info.dist.tarball}#${m}`,
        npm: { name, version, integrity: info.dist.integrity || null, tarball: info.dist.tarball, member: m },
      };
    }
  }
  throw new Error(`npm 包 ${name}@${version} 内找不到 ${filePath}`);
}

async function mirror(url, local) {
  if (!local) throw new Error(`无法解析资源地址 ${url}`);
  const parsed = parseUrl(url);
  if (!parsed) throw new Error(`无法解析资源地址 ${url}`);
  let result;
  if (parsed.host === 'cdn.jsdelivr.net' && parsed.pathname.startsWith('/npm/')) {
    const rest = parsed.pathname.slice('/npm/'.length).replace(/\/$/, '');
    const parts = rest.split('/');
    const pkgSpec = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
    const filePath = rest.slice(pkgSpec.length + 1);
    result = await fromNpm(pkgSpec, filePath);
  } else {
    const { buf, finalUrl } = await fetchBuf(url);
    result = { buf, resolvedUrl: finalUrl };
  }
  const dest = path.join(DIST, local.replace(/^\//, ''));
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, result.buf);
  return { url, resolvedUrl: result.resolvedUrl, npm: result.npm || null, local, sha256: sha256(result.buf), bytes: result.buf.length };
}

const dynamic = [
  // 运行时按需拼接的文件（页面里以模板字符串出现，静态扫描取不到完整地址）
  { url: 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/sql-wasm.wasm', local: '/assets/vendor/cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/sql-wasm.wasm' },
  { url: 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/sql-wasm.js', local: '/assets/vendor/cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/sql-wasm.js' },
];

// 兜底：cdnjs / unpkg 直连偶发失败时，按同一个 npm 包版本从 registry.npmjs.org 取
// （cdnjs 路径形如 /ajax/libs/<pkg>/<ver>/<file>，unpkg 路径形如 /<pkg>@<ver>/<file>）。
async function mirrorFromNpmFallback(url, local) {
  const parsed = parseUrl(url);
  if (!parsed) throw new Error(`无法解析 ${url}`);
  let pkgSpec = null;
  let filePath = null;
  if (parsed.host === 'cdnjs.cloudflare.com' && parsed.pathname.startsWith('/ajax/libs/')) {
    const parts = parsed.pathname.slice('/ajax/libs/'.length).split('/');
    if (parts.length >= 3) {
      const scoped = parts[0].startsWith('@');
      pkgSpec = scoped ? `${parts[0]}/${parts[1]}@${parts[2]}` : `${parts[0]}@${parts[1]}`;
      filePath = (scoped ? parts.slice(3) : parts.slice(2)).join('/');
    }
  } else if (parsed.host === 'unpkg.com') {
    const rest = parsed.pathname.slice(1);
    const idx = rest.indexOf('/');
    if (idx > 0) {
      pkgSpec = rest.slice(0, idx);
      filePath = rest.slice(idx + 1);
    }
  }
  if (!pkgSpec || !filePath) throw new Error(`无 npm 兜底映射：${url}`);
  pkgSpec = pkgSpec.replace(/\/$/, '');

  const dest = path.join(DIST, local.replace(/^\//, ''));
  mkdirSync(path.dirname(dest), { recursive: true });
  const errors = [];

  // 兜底 1：unpkg 同路径（CDN 直连偶发失败时通常仍可用）
  const unpkgUrl = `https://unpkg.com/${pkgSpec}/${filePath}`;
  try {
    const { buf } = await fetchBuf(unpkgUrl);
    writeFileSync(dest, buf);
    return { url, resolvedUrl: unpkgUrl, npm: null, local, sha256: sha256(buf), bytes: buf.length };
  } catch (e) {
    errors.push(`unpkg: ${String(e).split('\n')[0]}`);
  }

  // 兜底 2：npm registry tarball 内同名文件（版本锁定在 URL 里）
  try {
    const result = await fromNpm(pkgSpec, filePath);
    writeFileSync(dest, result.buf);
    return { url, resolvedUrl: result.resolvedUrl, npm: result.npm || null, local, sha256: sha256(result.buf), bytes: result.buf.length };
  } catch (e) {
    errors.push(`npm: ${String(e).split('\n')[0]}`);
  }
  throw new Error(errors.join(' | '));
}

let ok = 0;
const failures = [];
const fallbacks = [];
for (const u of assetUrls) {
  const local = localPathFor(u);
  try {
    lock.assets[u] = await mirror(u, local);
    ok++;
  } catch (e) {
    const first = String(e).split('\n')[0];
    try {
      lock.assets[u] = await mirrorFromNpmFallback(u, local);
      lock.assets[u].fallbackFrom = first;
      ok++;
      fallbacks.push({ url: u, firstError: first, from: lock.assets[u].resolvedUrl });
      console.error(`  FALLBACK ${u} -> npm（直连失败：${first}）`);
    } catch (e2) {
      failures.push({ url: u, error: first, fallbackError: String(e2).split('\n')[0] });
      console.error('  FAIL', u, first, '| npm 兜底也失败：', String(e2).split('\n')[0]);
    }
  }
  await sleep(40);
}
for (const d of dynamic) {
  try {
    lock.dynamic[d.url] = await mirror(d.url, d.local);
  } catch (e0) {
    try {
      lock.dynamic[d.url] = await mirrorFromNpmFallback(d.url, d.local);
      fallbacks.push({ url: d.url, firstError: String(e0).split('\n')[0], from: lock.dynamic[d.url].resolvedUrl });
      console.error(`  FALLBACK ${d.url} -> 兜底（直连失败：${String(e0).split('\n')[0]}）`);
      continue;
    } catch { /* 落到下面的失败分支 */ }
    const e = e0;
    failures.push({ url: d.url, error: String(e).split('\n')[0] });
    console.error('  FAIL', d.url, String(e).split('\n')[0]);
  }
}
writeFileSync(LOCK_FILE, JSON.stringify(lock, null, 1));
console.log(`CDN 资源：成功 ${ok}/${assetUrls.length}（其中 npm 兜底 ${fallbacks.length}），动态文件 ${Object.keys(lock.dynamic).length}，失败 ${failures.length}`);
if (fallbacks.length) console.log('兜底清单：\n' + fallbacks.map((f) => `  ${f.url} -> ${f.from}（${f.firstError}）`).join('\n'));
if (failures.length) {
  console.error('失败清单：\n' + failures.map((f) => `  ${f.url} -> ${f.error}`).join('\n'));
  process.exit(1);
}
console.log(`映射表写入 ${LOCK_FILE}`);
