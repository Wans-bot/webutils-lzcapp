#!/usr/bin/env node
// 修正上游「网站图标提取器」（tools/extractor/favicon-extractor.html）的「下载」按钮。
//
// 上游 v2.2.0 的实现（驳回点所在）：
//   window.downloadIcon = async function (url, domain, index) {
//     window.open(url, "_blank");           // url 是 https://www.google.com/s2/favicons?... 之类外链
//     showToast("已在新标签页打开，右键保存图片");
//   };
// 既不落盘、也不受平台保存框接管；图标又是 Google / DuckDuckGo 的跨域外链，
// 在客户端拦外链导航、或本机（境内网络）根本连不上这两个服务时，就是「点了没反应」。
//
// 本补丁把 extractFavicons / displayResults / downloadIcon 三段整体换成
// tools/favicon-tool-block.js 里的实现：
//   1. 图标经本应用同源代理（lzc-manifest.yml 的 wu-favicon-proxy）取字节，
//      数据源改成站点自己声明的图标（link rel=icon / apple-touch-icon / favicon.ico）；
//   2. 本机用 canvas 生成 16/32/48/64 四种尺寸 PNG；
//   3. 「下载」保存内存里已有的 blob —— 普通浏览器直接落盘，懒猫客户端由官方
//      open-save-chooser 注入接管成网盘保存框，下载阶段不再依赖第三方站点是否可达。
//
// 用法：node tools/patch-favicon-tool.mjs <distDir>

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = process.argv[2] || 'content/dist';
const TARGET = path.join(DIST, 'tools/extractor/favicon-extractor.html');
const BLOCK_FILE = path.join(HERE, 'favicon-tool-block.js');

const START_MARK = '      function extractFavicons() {';
const END_MARK = '      window.copyUrl = function (url) {';

let html;
try {
  html = readFileSync(TARGET, 'utf8');
} catch (err) {
  console.error(`无法读取 ${TARGET}：${err.message}`);
  process.exit(1);
}
let block;
try {
  block = readFileSync(BLOCK_FILE, 'utf8').replace(/\s+$/, '');
} catch (err) {
  console.error(`无法读取补丁块 ${BLOCK_FILE}：${err.message}`);
  process.exit(1);
}

const start = html.indexOf(START_MARK);
const end = html.indexOf(END_MARK);
if (start < 0 || end < 0 || end <= start) {
  console.error('补丁失败：上游页面里找不到 extractFavicons / copyUrl 的边界（页面结构可能已变化）');
  process.exit(1);
}

// 补丁块按页面内联脚本的缩进（6 个空格）写进去
const indented = block
  .split('\n')
  .map((line) => (line.trim() ? '      ' + line : ''))
  .join('\n');

let next = html.slice(0, start) + indented + '\n\n' + html.slice(end);

// 上游的 downloadIcon 整段删掉（新实现在补丁块里定义了 window.downloadIcon）
const dlRe = / {6}window\.downloadIcon = async function \(url, domain, index\) \{[\s\S]*?\n {6}\};\n/;
if (!dlRe.test(next)) {
  console.error('补丁失败：没找到上游的 window.downloadIcon 定义');
  process.exit(1);
}
next = next.replace(dlRe, '');

// 页面说明里补一句真实行为（原先写着「使用公开的图标获取服务」）
const noteAnchor = '<p>由于浏览器跨域限制，本工具使用公开的图标获取服务。以下是常用的 Favicon 获取 API：</p>';
if (!next.includes(noteAnchor)) {
  console.error('补丁失败：没找到服务说明段落');
  process.exit(1);
}
next = next.replace(
  noteAnchor,
  noteAnchor +
    '\n          <p>懒猫微服版本：图标由本机同源代理从站点自身获取（link rel=icon / apple-touch-icon / favicon.ico），' +
    '并在本机生成 16/32/48/64 四种尺寸；点「下载」会直接保存成 PNG 文件（客户端里可保存到懒猫网盘），' +
    '不再依赖外部 favicon 服务，也不会只把外链丢进新标签页。</p>',
);

// 自检
if (!next.includes('__favicon_proxy')) {
  console.error('补丁失败：产物里没有同源代理地址');
  process.exit(1);
}
if (next.includes('window.open(url, "_blank")')) {
  console.error('补丁失败：产物里仍有上游的 window.open 下载');
  process.exit(1);
}

writeFileSync(TARGET, next);
console.log(
  `favicon-extractor 补丁完成：替换 extractFavicons/displayResults（${start}..${end}）、` +
    `删除上游 downloadIcon、补充页面说明`,
);
