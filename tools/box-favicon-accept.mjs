#!/usr/bin/env node
// 真机验收：官审 20636 驳回点「网站图标提取器的下载按钮拿不到文件」。
//
// 同一台盒子、同一个 https 域名、同一份 dist，两个上下文对照：
//
//   A. 平台注入上下文（客户端真实形态）：点「下载」→ 官方 open-save-chooser 接管，
//      弹出「保存至懒猫」网盘保存框，saveNames 里是本次要保存的文件名。
//      同时把下载载荷（blob 字节数、PNG 尺寸）在页面里量出来作为内容证据。
//   B. 普通浏览器上下文：用 evaluateOnNewDocument 拦掉 lzc-file-picker 的注册，
//      等价于「没有平台保存框」，用 CDP Browser.setDownloadBehavior 让浏览器真的落盘，
//      逐个核对文件名 / 字节数 / sha256 / PNG 头。
//
// 回归：其它工具的下载与上传路径（Base64 图片解码下载、ICO 查看器上传+下载）在 B 上下文里跑。
//
// 用法：node tools/box-favicon-accept.mjs <baseUrl> <cdpUrl> <outDir>

import { writeFileSync, mkdirSync, readFileSync, rmSync, mkdirSync as mkdir } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadPuppeteer } from '/lzcapp/document/wans/lpk-skill/scripts/lib/load-puppeteer.mjs';

const BASE = (process.argv[2] || 'https://webutils.wans.heiyu.space').replace(/\/$/, '');
const CDP = process.argv[3] || 'http://127.0.0.1:9343';
const OUT = process.argv[4] || 'acceptance';
const DL = path.join(OUT, 'downloads');
const SHOTS = path.join(OUT, 'shots');
const SIZES = ['16x16', '32x32', '48x48', '64x64'];
const DOMAIN = 'baidu.com';
// Chrome 跑在盒子的容器里，下载目录经 -v $WORK:/root/wu-tkt 挂回盒子主机；
// 脚本在本地跑，所以用 ssh 列目录 / 取字节，再把证据文件 scp 回来。
const SSH = process.env.WU_SSH || 'lzcbox';
const LOCAL_DL = path.join(DL, 'plain');
const REMOTE_DL = '/root/wu-tkt/downloads/plain';
// 盒子登录会打印 MOTD，过滤掉，避免污染证据输出
const ssh = (cmd) =>
  execFileSync('ssh', [SSH, cmd], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => !/Welcome to Lazycat|Root is yours|casually tweak|AI agents|^\s*$/.test(line))
    .join('\n')
    .trim();

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function pngInfo(buf) {
  if (buf.length < 33) return { png: false, reason: `too short (${buf.length} B)` };
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return { png: false, reason: 'bad PNG signature' };
  let o = 8;
  while (o + 8 <= buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.subarray(o + 4, o + 8).toString('latin1');
    if (type === 'IHDR') {
      return { png: true, width: buf.readUInt32BE(o + 8), height: buf.readUInt32BE(o + 12), bitDepth: buf[o + 16] };
    }
    o += 12 + len;
  }
  return { png: false, reason: 'no IHDR' };
}

const results = [];
const record = (ctx, id, ok, detail) => {
  results.push({ ctx, id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${ctx}] ${id}  ${detail}`);
};

mkdirSync(DL, { recursive: true });
mkdirSync(SHOTS, { recursive: true });

// 平台组件噪音：本链路没有客户端会话，网盘客户端会 401 / WebSocket 鉴权失败，
// 官方选择器在拿不到 iframe 时也会抛 contentWindow 空引用。这些与应用无关，单独归类。
const PLATFORM_NOISE = [
  /401 \(Unauthorized\)/,
  /fileManager\/message/,
  /LazyCat download picker failed/,
  /deviceApiUrl/,
  /open-save-chooser_0\.js/,
  /file\.wans\.heiyu\.space/,
];
const isPlatformNoise = (entry) => {
  const text = `${entry.text || ''} ${entry.url || ''} ${entry.stack || ''}`;
  return PLATFORM_NOISE.some((re) => re.test(text));
};

const puppeteer = await loadPuppeteer();
const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });

const setValue = (page, selector, value) => page.evaluate((sel, v) => {
  const el = document.querySelector(sel);
  if (!el) return false;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}, selector, value);

const extract = async (page) => {
  await page.goto(`${BASE}/tools/extractor/favicon-extractor.html`, { waitUntil: 'networkidle2', timeout: 60000 });
  await wait(600);
  await setValue(page, '#urlInput', DOMAIN);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => /提取图标/.test(b.textContent || ''));
    if (btn) btn.click();
  });
  await page.waitForFunction(() => document.querySelectorAll('#iconsGrid .icon-card').length >= 5, { timeout: 45000 });
  await wait(800);
};

const cardPayload = (page) => page.evaluate(async () => {
  const out = [];
  for (const card of window.__wuFaviconCards || []) {
    let bytes = null;
    let dims = null;
    try {
      const blob = await (await fetch(card.blobUrl)).blob();
      bytes = blob.size;
      dims = await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => resolve(null);
        img.src = card.blobUrl;
      });
    } catch (e) {
      bytes = 'ERR ' + e.message;
    }
    out.push({ label: card.label, type: card.type, fileName: card.fileName, mime: card.mime, bytes, dims, sourceUrl: card.sourceUrl });
  }
  return out;
});

const clickDownload = (page, size) => page.evaluate((label) => {
  const card = [...document.querySelectorAll('#iconsGrid .icon-card')].find(
    (c) => (c.querySelector('.size')?.textContent || '').trim() === label && /本机生成/.test(c.querySelector('.type')?.textContent || ''),
  );
  if (!card) return null;
  const btn = [...card.querySelectorAll('button')].find((b) => /下载/.test(b.textContent || ''));
  if (!btn) return null;
  const r = btn.getBoundingClientRect();
  btn.click();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
}, size);

// ─────────────────────────────────────────────────────────────────────────────
// A. 平台注入上下文
// ─────────────────────────────────────────────────────────────────────────────
const A = { console: [], pageerrors: [], failed: [] };
{
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    let url = '';
    try { url = m.location()?.url || ''; } catch { /* ignore */ }
    A.console.push({ text: m.text().slice(0, 220), url: url.slice(0, 140) });
  });
  page.on('pageerror', (e) => A.pageerrors.push({ text: String(e).slice(0, 200), stack: String(e.stack || '').slice(0, 300) }));
  page.on('requestfailed', (r) => A.failed.push(`${r.url().slice(0, 120)} ${(r.failure() && r.failure().errorText) || ''}`));

  await extract(page);
  await page.screenshot({ path: path.join(SHOTS, 'pc-11-favicon-extracted.png') });
  const pickerReady = await page.evaluate(() => Boolean(customElements.get('lzc-file-picker')));
  record('A-平台注入', 'A0 官方网盘选择器已注册', pickerReady, `customElements.get('lzc-file-picker')=${pickerReady}`);

  const payload = await cardPayload(page);
  const generated = payload.filter((c) => c.mime === 'image/png' && c.type === '本机生成 PNG');
  record('A-平台注入', 'A1 提取出 16/32/48/64 四张图标 + 原始文件', generated.length === 4 && payload.length === 5,
    `卡片：${payload.map((c) => `${c.label}[${c.type}]`).join('，')}`);
  record('A-平台注入', 'A2 每张卡片的下载载荷都是可解码图片', payload.every((c) => typeof c.bytes === 'number' && c.bytes > 100 && c.dims),
    payload.map((c) => `${c.label}: ${c.bytes} B ${c.dims ? c.dims.w + 'x' + c.dims.h : '-'}`).join(' | '));
  record('A-平台注入', 'A3 生成尺寸与标签一致', generated.every((c) => c.dims && `${c.dims.w}x${c.dims.h}` === c.label),
    generated.map((c) => `${c.label}→${c.dims && c.dims.w + 'x' + c.dims.h}`).join(' '));
  record('A-平台注入', 'A4 复制链接目标仍是站点真实图标地址', payload.every((c) => /^https:\/\/www\.baidu\.com\/favicon\.ico$/.test(c.sourceUrl)),
    payload[0].sourceUrl);

  // 逐尺寸点「下载」：每次重新加载页面，避免上一次保存框残留影响判定
  for (const size of SIZES) {
    await extract(page);
    const expected = `favicon-${DOMAIN}-${size}.png`;
    await page.evaluate(() => {
      window.__copied = null;
      const clip = navigator.clipboard;
      if (clip && clip.writeText) {
        const original = clip.writeText.bind(clip);
        clip.writeText = (text) => { window.__copied = text; return original(text).catch(() => {}); };
      }
    });
    await clickDownload(page, size);
    let dialog = null;
    for (let i = 0; i < 40; i++) {
      await wait(250);
      const frame = page.frames().find((f) => /filepicker2/.test(f.url()) && decodeURIComponent(f.url()).includes(expected));
      if (frame) {
        dialog = { url: decodeURIComponent(frame.url()).slice(0, 260) };
        break;
      }
    }
    await page.screenshot({ path: path.join(SHOTS, `pc-12-download-${size}.png`) });
    record('A-平台注入', `A5-${size} 点下载弹出网盘保存框且文件名正确`, Boolean(dialog),
      dialog ? dialog.url : '未出现包含该文件名的保存框');
    await page.keyboard.press('Escape');
    await wait(400);
  }

  // 复制链接（拦截 clipboard.writeText 取证，不依赖剪贴板权限）
  await extract(page);
  await page.evaluate(() => {
    window.__copied = null;
    const clip = navigator.clipboard;
    if (clip && clip.writeText) {
      const original = clip.writeText.bind(clip);
      clip.writeText = (text) => { window.__copied = text; return original(text).catch(() => {}); };
    }
    const card = document.querySelector('#iconsGrid .icon-card');
    [...card.querySelectorAll('button')].find((b) => /复制链接/.test(b.textContent || '')).click();
  });
  await wait(600);
  const copied = await page.evaluate(() => window.__copied);
  record('A-平台注入', 'A6 复制链接仍可用', typeof copied === 'string' && /baidu\.com\/favicon\.ico/.test(copied), `复制到：${copied}`);

  const appConsole = A.console.filter((e) => !isPlatformNoise(e));
  const appPageErrors = A.pageerrors.filter((e) => !isPlatformNoise(e));
  record('A-平台注入', 'A7 页面无应用自身 console 错误', appConsole.length === 0,
    `${appConsole.slice(0, 3).map((e) => e.text).join(' | ') || '无'}（平台组件噪音 ${A.console.length - appConsole.length} 条）`);
  record('A-平台注入', 'A8 页面无应用自身 pageerror', appPageErrors.length === 0,
    `${appPageErrors.slice(0, 2).map((e) => e.text).join(' | ') || '无'}（平台组件噪音 ${A.pageerrors.length - appPageErrors.length} 条）`);
  const appFailed = A.failed.filter((u) => !isPlatformNoise({ url: u }));
  record('A-平台注入', 'A9 应用自身无失败请求', appFailed.length === 0,
    `${appFailed.slice(0, 3).join(' | ') || '无'}（平台组件失败 ${A.failed.length - appFailed.length} 条）`);
  await page.close();
}

// ─────────────────────────────────────────────────────────────────────────────
// B. 普通浏览器上下文（没有平台保存框，浏览器直接落盘）
// ─────────────────────────────────────────────────────────────────────────────
const B = { console: [], pageerrors: [], failed: [], files: [] };
{
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  // 让 customElements 拒绝注册官方保存框组件：等价于「这个环境没有懒猫客户端注入」
  await page.evaluateOnNewDocument(() => {
    const define = customElements.define.bind(customElements);
    customElements.define = function (name, ctor, options) {
      if (name === 'lzc-file-picker') return;
      return define(name, ctor, options);
    };
  });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    let url = '';
    try { url = m.location()?.url || ''; } catch { /* ignore */ }
    B.console.push({ text: m.text().slice(0, 220), url: url.slice(0, 140) });
  });
  page.on('pageerror', (e) => B.pageerrors.push({ text: String(e).slice(0, 200), stack: String(e.stack || '').slice(0, 300) }));
  page.on('requestfailed', (r) => B.failed.push(`${r.url().slice(0, 120)} ${(r.failure() && r.failure().errorText) || ''}`));

  rmSync(LOCAL_DL, { recursive: true, force: true });
  mkdirSync(LOCAL_DL, { recursive: true });
  ssh(`rm -rf ${REMOTE_DL} && mkdir -p ${REMOTE_DL} && chmod 777 ${REMOTE_DL}`);
  const client = await page.target().createCDPSession();
  try {
    await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: REMOTE_DL, eventsEnabled: true });
  } catch {
    await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: REMOTE_DL });
  }

  // Chrome 容器里下载完成后文件出现在盒子主机 ${REMOTE_DL}；用 ssh 取回字节做 sha256/PNG 校验
  const waitForFile = async (pattern, tries = 60) => {
    for (let i = 0; i < tries; i++) {
      await wait(250);
      let names = [];
      try { names = ssh(`ls -1 ${REMOTE_DL} 2>/dev/null || true`).split('\n').filter(Boolean); } catch { names = []; }
      const hit = names.filter((n) => !n.endsWith('.crdownload') && pattern.test(n));
      if (hit.length) {
        const name = hit[hit.length - 1];
        const buf = Buffer.from(ssh(`base64 -w0 ${JSON.stringify(path.posix.join(REMOTE_DL, name))}`), 'base64');
        mkdir(path.join(LOCAL_DL), { recursive: true });
        writeFileSync(path.join(LOCAL_DL, name), buf);
        return {
          name,
          remote: path.posix.join(REMOTE_DL, name),
          local: path.join(LOCAL_DL, name),
          bytes: buf.length,
          sha256: sha256(buf),
          png: pngInfo(buf),
        };
      }
    }
    return null;
  };

  await extract(page);
  const noPicker = await page.evaluate(() => Boolean(customElements.get('lzc-file-picker')));
  record('B-普通浏览器', 'B0 对照上下文里没有平台保存框', noPicker === false, `customElements.get('lzc-file-picker')=${noPicker}`);
  await page.screenshot({ path: path.join(SHOTS, 'pc-20-favicon-plain-browser.png') });

  for (const size of SIZES) {
    await extract(page);
    await clickDownload(page, size);
    const file = await waitForFile(new RegExp(`^favicon-${DOMAIN.replace(/\./g, '\\.')}-${size}\\.png$`));
    record('B-普通浏览器', `B1-${size} 点下载后浏览器落盘`, Boolean(file),
      file ? `${file.remote} → ${file.local} ${file.bytes} B sha256=${file.sha256}` : `盒子 ${REMOTE_DL} 内没有 favicon-${DOMAIN}-${size}.png`);
    if (file) {
      record('B-普通浏览器', `B2-${size} 落盘文件可打开且尺寸正确`,
        file.png.png && `${file.png.width}x${file.png.height}` === size,
        file.png.png ? `PNG ${file.png.width}x${file.png.height} bitDepth=${file.png.bitDepth}` : file.png.reason);
    }
  }
  await page.screenshot({ path: path.join(SHOTS, 'pc-21-favicon-downloads.png') });

  // 回归 1：Base64 图片工具「解码 + 下载图片」
  await page.goto(`${BASE}/tools/media/base64-image.html`, { waitUntil: 'networkidle2', timeout: 60000 });
  await wait(800);
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKElEQVR42u3NMQEAAAgDoJnc6BpjDyQgd2XKlClTpkyZMmXKlClTpkzZS9kHqgABBc/qXQAAAABJRU5ErkJggg==';
  await page.evaluate(() => {
    const tab = document.querySelector('button.tab-btn[data-tab="decode"]');
    if (tab) tab.click();
  });
  await wait(400);
  await setValue(page, '#decodeInput', dataUrl);
  await page.evaluate(() => document.getElementById('decodeBtn').click());
  await wait(1500);
  const decodeOk = await page.evaluate(() => {
    const box = document.getElementById('decodeActions');
    return { visible: box ? getComputedStyle(box).display !== 'none' : false, status: (document.getElementById('decodeStatus')?.textContent || '').trim() };
  });
  await page.evaluate(() => document.getElementById('downloadImageBtn').click());
  const b64File = await waitForFile(/^decoded_image\./);
  record('B-普通浏览器', 'B3 Base64 图片工具解码并下载', Boolean(b64File) && decodeOk.visible,
    b64File ? `${b64File.remote} ${b64File.bytes} B sha256=${b64File.sha256} PNG=${b64File.png.png} 状态=${decodeOk.status}` : `未落盘（状态=${decodeOk.status}）`);

  // 回归 2：ICO 查看器「上传 .ico → 下载 PNG」
  const icoPath = path.join(OUT, 'sample.ico');
  // Chrome 跑在盒子容器里：uploadFile 传的是「Chrome 所在机器」的路径，
  // 本地路径它读不到（表现为 file 空、FileReader 静默失败）。所以先传到挂载目录里。
  const remoteIco = '/root/wu-tkt/sample.ico';
  execFileSync('scp', ['-q', icoPath, `${SSH}:${remoteIco}`]);
  await page.goto(`${BASE}/tools/media/ico-viewer.html`, { waitUntil: 'networkidle2', timeout: 60000 });
  await wait(800);
  const icoInput = await page.$('#fileInput');
  let icoOk = { uploaded: false, detail: '没有 input[type=file]' };
  if (icoInput && readFileSync(icoPath)) {
    await icoInput.uploadFile(remoteIco);
    for (let i = 0; i < 20; i++) {
      await wait(400);
      const st = await page.evaluate(() => ({
        grid: document.querySelectorAll('#iconsGrid *').length,
        err: (document.getElementById('errorStatus')?.textContent || '').trim(),
      }));
      if (st.grid > 3) { icoOk = { uploaded: true, detail: `图标网格节点 ${st.grid}` }; break; }
      icoOk = { uploaded: false, detail: `网格节点 ${st.grid} 错误=${st.err || '-'}` };
    }
  }
  record('B-普通浏览器', 'B4 ICO 查看器上传 .ico 后解析成功', icoOk.uploaded, icoOk.detail);
  if (icoOk.uploaded) {
    const clicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => /下载/.test(b.textContent || ''));
      if (!btn) return false;
      btn.click();
      return true;
    });
    const icoFile = await waitForFile(/^icon_.*\.png$/);
    record('B-普通浏览器', 'B5 ICO 查看器下载 PNG', Boolean(icoFile),
      icoFile ? `${icoFile.remote} ${icoFile.bytes} B sha256=${icoFile.sha256} PNG=${icoFile.png.png}` : `未落盘（点击=${clicked}）`);
  }
  await page.screenshot({ path: path.join(SHOTS, 'pc-22-regression-tools.png') });

  const bConsole = B.console.filter((e) => !isPlatformNoise(e));
  const bErrors = B.pageerrors.filter((e) => !isPlatformNoise(e));
  record('B-普通浏览器', 'B6 页面无应用自身 console 错误', bConsole.length === 0,
    `${bConsole.slice(0, 3).map((e) => e.text).join(' | ') || '无'}（平台组件噪音 ${B.console.length - bConsole.length} 条）`);
  record('B-普通浏览器', 'B7 页面无应用自身 pageerror', bErrors.length === 0,
    `${bErrors.slice(0, 2).map((e) => e.text).join(' | ') || '无'}（平台组件噪音 ${B.pageerrors.length - bErrors.length} 条）`);
  await page.close();
}

await browser.disconnect();

const report = {
  base: BASE,
  at: new Date().toISOString(),
  A: { consoleErrors: A.console, pageErrors: A.pageerrors, failedRequests: A.failed },
  B: { consoleErrors: B.console, pageErrors: B.pageerrors, failedRequests: B.failed, files: B.files },
  results,
  passed: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok).length,
};
writeFileSync(path.join(OUT, 'favicon-accept.json'), JSON.stringify(report, null, 1));
console.log(`\n共 ${results.length} 项：通过 ${report.passed}，失败 ${report.failed}；报告写入 ${path.join(OUT, 'favicon-accept.json')}`);
process.exit(report.failed ? 1 : 0);
