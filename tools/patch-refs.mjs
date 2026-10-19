#!/usr/bin/env node
// 把站点里指向外部 CDN 的资源引用改写到本地镜像路径（映射表由 mirror-assets.mjs 生成）。
//
// 只替换映射表里出现过的完整 URL，逐条从长到短，避免前缀互相吃掉。
// HTML 属性里可能写成 &amp; 形式，因此每个 URL 同时准备原始与转义两种写法。
//
// 用法：node tools/patch-refs.mjs <distDir> <lockFile>

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const DIST = process.argv[2] || 'content/dist';
const LOCK_FILE = process.argv[3] || '.build/vendor-lock.json';

let lock;
try {
  lock = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
} catch (err) {
  console.error(`无法读取映射表 ${LOCK_FILE}：${err.message}`);
  console.error('先执行 node tools/mirror-assets.mjs 生成映射表');
  process.exit(1);
}

// URL → 本地路径
const map = new Map();
for (const [url, local] of Object.entries(lock.fonts.urls)) map.set(url, local);
for (const [url, entry] of Object.entries(lock.assets)) map.set(url, entry.local);
for (const [url, entry] of Object.entries(lock.dynamic)) map.set(url, entry.local);

// 目录前缀改写：页面用模板字符串拼出的运行时文件（例如 sql.js 的 sql-wasm.wasm）
const prefixPairs = [
  ['https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/', '/assets/vendor/cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/'],
];

// 长 URL 先替换，避免短前缀命中长 URL 的开头
const pairs = [...map.entries(), ...prefixPairs].sort((a, b) => b[0].length - a[0].length);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(html|js|css)$/i.test(name)) out.push(p);
  }
  return out;
}

const escapeAttr = (s) => s.replace(/&/g, '&amp;');

let changedFiles = 0;
let replacements = 0;
for (const file of walk(DIST)) {
  const before = readFileSync(file, 'utf8');
  let after = before;
  for (const [url, local] of pairs) {
    for (const variant of new Set([url, escapeAttr(url)])) {
      if (!after.includes(variant)) continue;
      const parts = after.split(variant);
      replacements += parts.length - 1;
      after = parts.join(local);
    }
  }
  // 清掉指向 Google Fonts 的 preconnect（本地已不需要预连接外部域）
  after = after.replace(/\s*<link[^>]*rel="preconnect"[^>]*fonts\.(googleapis|gstatic)\.com[^>]*>/gi, '');
  if (after !== before) {
    writeFileSync(file, after);
    changedFiles++;
  }
}

// 复核：dist 里不应再出现这些外部主机（tools.realtime-ai.chat 等自站链接不在镜像范围）
const hostsLeft = new Map();
for (const file of walk(DIST)) {
  const txt = readFileSync(file, 'utf8');
  for (const m of txt.matchAll(/https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//g)) {
    hostsLeft.set(m[1], (hostsLeft.get(m[1]) || 0) + 1);
  }
}
console.log(`改写 ${changedFiles} 个文件，替换 ${replacements} 处外部引用`);
if (hostsLeft.size) {
  console.log('仍有外部引用：' + [...hostsLeft.entries()].map(([h, n]) => `${h}×${n}`).join('，'));
  console.log('（这些是无法镜像或刻意保留的动态地址，需在实测记录里逐条说明）');
} else {
  console.log('dist 内已无 CDN 与 Google Fonts 引用');
}
