#!/usr/bin/env node
// G3 实机验收：通过盒子上的无头 Chrome（CDP）走真实 https 应用域名，逐项检查。
//
// 用法：node tools/box-accept.mjs <baseUrl> <cdpUrl> <outJson>
//   例：node tools/box-accept.mjs https://webutils.wans.heiyu.space http://127.0.0.1:9335 out/accept.json
//
// 只做检查，不改盒子状态。

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadPuppeteer } from '/lzcapp/document/wans/lpk-skill/scripts/lib/load-puppeteer.mjs';

const BASE = (process.argv[2] || 'https://webutils.wans.heiyu.space').replace(/\/$/, '');
const CDP = process.argv[3] || 'http://127.0.0.1:9335';
const OUT = process.argv[4] || 'out/accept.json';

const results = [];
const record = (id, ok, detail) => {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${detail}`);
};

const puppeteer = await loadPuppeteer();
const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });
const externalHosts = new Set();
const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];

async function newInstrumentedPage(viewport) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    let url = '';
    try { url = m.location()?.url || ''; } catch { url = ''; }
    consoleErrors.push({ text: m.text().slice(0, 160), url: url.slice(0, 120) });
  });
  page.on('pageerror', (e) => pageErrors.push({ text: String(e).slice(0, 160), stack: String(e.stack || '').slice(0, 400) }));
  page.on('requestfailed', (r) => failedRequests.push(`${r.url().slice(0, 100)} ${r.failure()?.errorText || ''}`));
  page.on('request', (r) => {
    const u = r.url();
    try {
      const host = new URL(u).host;
      if (!u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('blob:')) externalHosts.add(host);
    } catch { /* 忽略非法 URL */ }
  });
  return page;
}

const setValue = (page, selector, value) => page.evaluate((sel, v) => {
  const el = document.querySelector(sel);
  if (!el) return false;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}, selector, value);

// ── A. 首装首屏 ───────────────────────────────────────────────────────────────
const page = await newInstrumentedPage({ width: 1600, height: 1000 });
const t0 = Date.now();
await page.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 60000 });
const readyMs = Date.now() - t0;
await new Promise((r) => setTimeout(r, 1500));

const hub = await page.evaluate(() => {
  const text = document.body.innerText || '';
  const injects = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/_lzc/injects/'));
  return {
    title: document.title,
    lang: document.documentElement.lang,
    cjk: (text.match(/[\u4e00-\u9fa5]/g) || []).length,
    injects,
    pickerDefined: !!customElements.get('lzc-file-picker'),
    toolCards: document.querySelectorAll('.tool-card').length,
    hasSearch: !!document.querySelector('input[type="search"],input[type="text"],#searchInput'),
    fontFamily: getComputedStyle(document.body).fontFamily,
    toolCountText: (text.match(/1088/g) || []).length,
    localStoreKeys: Object.keys(localStorage).length,
    externalFallback: [...document.querySelectorAll('link[rel="stylesheet"][href^="http"],script[src^="http"],img[src^="http"]')]
      .filter((e) => !(e.getAttribute('href') || e.getAttribute('src')).startsWith(location.origin)).length,
  };
});

record('A1 首屏就绪', readyMs < 60000, `${readyMs} ms；≤ 官方 5 分钟上限`);
record('A2 中文界面', hub.lang === 'zh-CN' && hub.cjk > 100 && /WebUtils/.test(hub.title), `lang=${hub.lang} 标题=${hub.title} 可见中文字 ${hub.cjk}`);
record('A3 工具索引渲染', hub.toolCards >= 1000, `首页工具卡片 ${hub.toolCards} 个（上游声明 1088）`);
record('A4 平台注入送达', hub.injects.some((n) => n.includes('open-save-chooser')), hub.injects.join(' | ') || '未发现注入资源');
record('A5 官方选择器已注册', hub.pickerDefined, `customElements.get('lzc-file-picker')=${hub.pickerDefined}`);
record('A6 无站外样式/脚本依赖', hub.externalFallback === 0, `站外 stylesheet/script/img 引用 ${hub.externalFallback} 处`);
record('A7 本地字体生效', /Space Grotesk/.test(hub.fontFamily), `body 字体=${hub.fontFamily}`);

// ── B. 工具功能 ───────────────────────────────────────────────────────────────
const jsonPage = await newInstrumentedPage({ width: 1600, height: 1000 });
await jsonPage.goto(BASE + '/tools/dev/json-formatter.html', { waitUntil: 'networkidle2', timeout: 60000 });
await setValue(jsonPage, '#input', '{"b":2,"a":[1,2,3]}');
await jsonPage.evaluate(() => document.querySelector('#btnFormat').click());
await new Promise((r) => setTimeout(r, 800));
const jsonOut = await jsonPage.evaluate(() => document.querySelector('#output')?.value || document.querySelector('#output')?.textContent || '');
record('B1 JSON 格式化', /\n/.test(jsonOut) && /"b"/.test(jsonOut), `输出片段: ${JSON.stringify(jsonOut.slice(0, 60))}`);
await jsonPage.close();

const b64Page = await newInstrumentedPage({ width: 1600, height: 1000 });
await b64Page.goto(BASE + '/tools/dev/base64.html', { waitUntil: 'networkidle2', timeout: 60000 });
await setValue(b64Page, '#input', '懒猫微服 webutils');
await b64Page.evaluate(() => document.querySelector('#btnEncode').click());
await new Promise((r) => setTimeout(r, 800));
const b64Out = await b64Page.evaluate(() => document.querySelector('#output')?.value || document.querySelector('#output')?.textContent || '');
record('B2 Base64 编码', b64Out.replace(/\s/g, '').length > 10, `输出片段: ${JSON.stringify(b64Out.slice(0, 40))}`);

// 同一页上验证注入幂等：同一注入脚本再插一次，不应出现 pageerror
const beforeErr = pageErrors.length;
await b64Page.evaluate(() => {
  const s = document.createElement('script');
  s.src = '/_lzc/injects/open-save-chooser_0.js';
  document.head.appendChild(s);
});
await new Promise((r) => setTimeout(r, 1500));
record('B3 注入幂等', pageErrors.length === beforeErr, `重复注入后新增 pageerror ${pageErrors.length - beforeErr} 条`);
await b64Page.close();

const qrPage = await newInstrumentedPage({ width: 1600, height: 1000 });
await qrPage.goto(BASE + '/tools/generator/qrcode-generator.html', { waitUntil: 'networkidle2', timeout: 60000 });
await setValue(qrPage, '#textInput', 'https://webutils.wans.heiyu.space');
await qrPage.evaluate(() => {
  const el = document.querySelector('#textInput');
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await new Promise((r) => setTimeout(r, 1200));
const qr = await qrPage.evaluate(() => {
  const c = document.querySelector('#qrCanvas');
  if (!c) return { has: false };
  try {
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 128) dark++;
    return { has: true, w: c.width, h: c.height, dark };
  } catch (e) { return { has: true, error: String(e).slice(0, 80) }; }
});
record('B4 二维码生成', qr.has && qr.dark > 100, `canvas ${qr.w}x${qr.h} 深色像素 ${qr.dark}`);

// 网盘文件选择器：真实点击带 input[type=file] 的工具入口，应弹出官方统一窗口
const filePage = await newInstrumentedPage({ width: 1600, height: 1000 });
await filePage.goto(BASE + '/tools/dev/base64.html', { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise((r) => setTimeout(r, 1200));
const triggerBox = await filePage.evaluate(() => {
  const input = document.querySelector('#fileInput');
  const label = input ? document.querySelector(`label[for="${input.id}"]`) : null;
  const el = label || [...document.querySelectorAll('button,label,[role=button]')].find((n) => /选择文件/.test(n.textContent || ''));
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
});
if (triggerBox) await filePage.mouse.click(triggerBox.x, triggerBox.y);
// 网盘目录列表是异步拉取的：等它渲染出来再判断（本轮实测 3 秒内已出目录）
await new Promise((r) => setTimeout(r, 6000));
// 官方选择器把网盘界面放在 file.<微服域名>/#/filepicker2 的 iframe 里，
// 因此按 frame 判断，而不是只找宿主页面的 shadow DOM。
const picker = { found: false };
for (const f of filePage.frames()) {
  const u = f.url();
  if (!/filepicker/i.test(u)) continue;
  let txt = '';
  try { txt = await f.evaluate(() => (document.body ? document.body.innerText : '').replace(/\s+/g, ' ')); } catch { txt = ''; }
  let hostText = '';
  try { hostText = await filePage.evaluate(() => document.body.innerText || ''); } catch { hostText = ''; }
  picker.found = true;
  picker.frame = u.slice(0, 100);
  picker.tabs = ['网盘文件', '本地文件', '从懒猫打开'].filter((t) => (txt + hostText).includes(t));
  picker.dirs = ['全部文件', '我的收藏', '外接硬盘', '他人共享', '远程挂载', '本地同步'].filter((t) => txt.includes(t));
  picker.sample = txt.slice(0, 160);
  break;
}
await filePage.screenshot({ path: 'out/picker-open.png' }).catch(() => {});
record('B5 网盘选择器弹出', picker.found && picker.dirs.length >= 3,
  `iframe=${picker.frame || '未找到'} 标签=${(picker.tabs || []).join('/')} 网盘目录=${(picker.dirs || []).join('/')} 内容样例=${picker.sample || '-'}`);
await filePage.close();
await qrPage.close();

// ── C. 从首页进入工具页 ───────────────────────────────────────────────────────
await page.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise((r) => setTimeout(r, 800));
const navOk = await page.evaluate(async () => {
  const link = document.querySelector('.tool-card');
  if (!link) return { ok: false };
  return { ok: true, href: link.getAttribute('href') };
});
if (navOk.ok) {
  await page.goto(BASE + '/' + String(navOk.href).replace(/^\//, ''), { waitUntil: 'networkidle2', timeout: 45000 });
  await new Promise((r) => setTimeout(r, 600));
}
const navLanded = await page.evaluate(() => ({ title: document.title, hasToolUi: !!document.querySelector('textarea,input,canvas,button') }));
record('C1 首页可进入工具页', navOk.ok && navLanded.hasToolUi, `${navOk.href} → 标题=${navLanded.title}`);

// ── D. 移动端三层自检 ─────────────────────────────────────────────────────────
const mobile = await newInstrumentedPage({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await mobile.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise((r) => setTimeout(r, 1200));
const mob = await mobile.evaluate(() => {
  const de = document.documentElement;
  const overflowDoc = de.scrollWidth - de.clientWidth;
  let worst = 0, worstTag = '';
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width > de.clientWidth + 4) {
      const over = Math.round(r.width - de.clientWidth);
      if (over > worst) { worst = over; worstTag = el.tagName + '.' + String(el.className).slice(0, 30); }
    }
  }
  return { overflowDoc, worst, worstTag, viewportMeta: !!document.querySelector('meta[name="viewport"]'), cjk: ((document.body.innerText || '').match(/[\u4e00-\u9fa5]/g) || []).length };
});
record('D1 移动端无横向溢出', mob.overflowDoc <= 2, `documentElement 溢出 ${mob.overflowDoc}px；单元素最宽超出 ${mob.worst}px ${mob.worstTag}`);
record('D2 移动端 viewport', mob.viewportMeta, `viewport meta=${mob.viewportMeta}，中文可见字 ${mob.cjk}`);
await mobile.close();

// ── E. 刷新后本地状态保留 ─────────────────────────────────────────────────────
await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
await new Promise((r) => setTimeout(r, 800));
const after = await page.evaluate(() => ({ keys: Object.keys(localStorage).length, title: document.title }));
record('E1 刷新后可用', /WebUtils/.test(after.title), `localStorage 键 ${hub.localStoreKeys} → ${after.keys}，标题=${after.title}`);
await page.close();

await browser.disconnect();

// ── 汇总 ─────────────────────────────────────────────────────────────────────
const cdnHosts = [...externalHosts].filter((h) => /googleapis|gstatic|jsdelivr|cdnjs|unpkg|cdn\./i.test(h));
// 网盘实时通道（fileManager WebSocket）在本链路拿不到客户端会话，会报鉴权失败；
// 这是链路限制，同类结论见 musicblocks 实测记录。其余 console 错误一律记失败。
// 平台组件（网盘客户端 file.<微服域名>、设备服务 ai.<微服域名>）在本链路没有客户端会话，
// 会报 401 / deviceApiUrl 之类错误；这些与应用无关，单独归类以便逐条说明。
const appHost = new URL(BASE).host;
const isPlatformHost = (u) => {
  try {
    const h = new URL(u).host;
    return h !== appHost && /(^|\.)wans\.heiyu\.space$/.test(h);
  } catch { return false; }
};
const platformConsoleErrors = consoleErrors.filter((e) => isPlatformHost(e.url));
const appConsoleErrors = consoleErrors.filter((e) => !platformConsoleErrors.includes(e));
const platformPageErrors = pageErrors.filter((e) => /file\.wans\.heiyu\.space|ai\.wans\.heiyu\.space/.test(e.stack));
const appPageErrors = pageErrors.filter((e) => !platformPageErrors.includes(e));
const platformFailedRequests = failedRequests.filter((u) => /file\.wans\.heiyu\.space|ai\.wans\.heiyu\.space/.test(u));
const appFailedRequests = failedRequests.filter((u) => !platformFailedRequests.includes(u));

record('F1 应用自身的 console 错误为 0', appConsoleErrors.length === 0,
  (appConsoleErrors.slice(0, 3).map((e) => e.text).join(' | ') || '无') +
  `（平台网盘组件错误 ${platformConsoleErrors.length} 条：本链路无客户端会话）`);
record('F2 应用自身无 pageerror', appPageErrors.length === 0,
  (appPageErrors.slice(0, 2).map((e) => e.text).join(' | ') || '无') +
  `（平台网盘组件 pageerror ${platformPageErrors.length} 条）`);
record('F3 应用自身无失败请求', appFailedRequests.length === 0,
  (appFailedRequests.slice(0, 3).join(' | ') || '无') +
  `（平台服务失败请求 ${platformFailedRequests.length} 条）`);
record('F4 无外部 CDN 请求', cdnHosts.length === 0, cdnHosts.join(' | ') || '无');

const report = {
  base: BASE, cdp: CDP, at: new Date().toISOString(),
  readyMs,
  hub,
  externalHosts: [...externalHosts],
  consoleErrors, appConsoleErrors, platformConsoleErrors, pageErrors, appPageErrors, platformPageErrors, failedRequests, appFailedRequests,
  results,
  passed: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok).length,
};
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log(`\n共 ${results.length} 项：通过 ${report.passed}，失败 ${report.failed}；报告写入 ${OUT}`);
process.exit(report.failed ? 1 : 0);
