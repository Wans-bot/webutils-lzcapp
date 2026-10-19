#!/usr/bin/env node
// 临时排错探针：打开图标提取器，输入域名点提取，打印页面状态、错误文案、网络与 console。
import { loadPuppeteer } from '/lzcapp/document/wans/lpk-skill/scripts/lib/load-puppeteer.mjs';

const BASE = (process.argv[2] || 'https://webutils.wans.heiyu.space').replace(/\/$/, '');
const CDP = process.argv[3] || 'http://127.0.0.1:9343';
const DOMAIN = process.argv[4] || 'baidu.com';

const puppeteer = await loadPuppeteer();
const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 1000 });
const logs = [];
page.on('console', (m) => logs.push(`[console.${m.type()}] ${m.text().slice(0, 200)}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${String(e).slice(0, 200)}`));
page.on('requestfailed', (r) => logs.push(`[failed] ${r.url().slice(0, 120)} ${r.failure()?.errorText || ''}`));
page.on('response', (r) => { if (r.url().includes('__favicon_proxy')) logs.push(`[resp] ${r.status()} ${r.url().slice(0, 160)}`); });

await page.goto(`${BASE}/tools/extractor/favicon-extractor.html`, { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise((r) => setTimeout(r, 800));
await page.evaluate((d) => {
  const el = document.getElementById('urlInput');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, d);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  const btn = [...document.querySelectorAll('button')].find((b) => /提取图标/.test(b.textContent || ''));
  btn.click();
}, DOMAIN);

// 轮询 20 秒，看卡片/错误文案何时出现
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const state = await page.evaluate(() => ({
    cards: document.querySelectorAll('#iconsGrid .icon-card').length,
    err: (document.getElementById('errorMsg')?.textContent || '').trim(),
    errShown: document.getElementById('errorMsg')?.style.display,
    loading: document.getElementById('loading')?.className,
    toast: (document.getElementById('toast')?.textContent || '').trim(),
  }));
  console.log(i + 1, JSON.stringify(state));
  if (state.cards > 0) break;
}
await page.screenshot({ path: '/tmp/wu-probe.png' });
const diag = await page.evaluate(async () => {
  const out = {};
  try {
    const r = await fetch('/__favicon_proxy/www.baidu.com/', { credentials: 'same-origin', cache: 'no-store' });
    out.html = { status: r.status, ct: r.headers.get('content-type'), len: (await r.text()).length };
  } catch (e) { out.html = 'ERR ' + e.message; }
  try {
    const r2 = await fetch('/__favicon_proxy/www.baidu.com/favicon.ico', { credentials: 'same-origin', cache: 'no-store' });
    const b = await r2.blob();
    out.ico = { status: r2.status, ct: r2.headers.get('content-type'), bytes: b.size };
    const img = new Image();
    const url = URL.createObjectURL(b);
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('img decode fail')); img.src = url; });
    out.ico.natural = img.naturalWidth + 'x' + img.naturalHeight;
  } catch (e) { out.ico = 'ERR ' + e.message; }
  return out;
});
console.log('DIAG', JSON.stringify(diag));
console.log(logs.slice(0, 25).join('\n'));
await page.close();
await browser.disconnect();
