#!/usr/bin/env node
// 排错探针 3：普通浏览器上下文里 CDP 下载行为是否生效（无平台保存框）。
import { mkdirSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadPuppeteer } from '/lzcapp/document/wans/lpk-skill/scripts/lib/load-puppeteer.mjs';

const BASE = 'https://webutils.wans.heiyu.space';
const CDP = process.argv[2] || 'http://127.0.0.1:9343';
const DIR = '/tmp/wu-dl-probe';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

const puppeteer = await loadPuppeteer();
const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });
const page = await browser.newPage();
await page.evaluateOnNewDocument(() => {
  const define = customElements.define.bind(customElements);
  customElements.define = function (name, ctor, options) {
    if (name === 'lzc-file-picker') return;
    return define(name, ctor, options);
  };
});
const client = await page.target().createCDPSession();
await client.send('Page.enable');
client.on('Browser.downloadWillBegin', (e) => console.log('EVENT downloadWillBegin', JSON.stringify(e).slice(0, 200)));
client.on('Browser.downloadProgress', (e) => console.log('EVENT downloadProgress', JSON.stringify(e).slice(0, 160)));
client.on('Page.downloadWillBegin', (e) => console.log('EVENT page.downloadWillBegin', JSON.stringify(e).slice(0, 200)));

for (const cmd of [
  ['Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DIR, eventsEnabled: true }],
]) {
  try { await client.send(cmd[0], cmd[1]); console.log('OK', cmd[0]); } catch (e) { console.log('FAIL', cmd[0], e.message); }
}

await page.goto(`${BASE}/tools/media/ico-viewer.html`, { waitUntil: 'networkidle2', timeout: 60000 });
await wait(700);
// 直接造一个 blob 链接点击，验证下载通道本身
const r = await page.evaluate(async () => {
  const blob = new Blob([new Uint8Array([137, 80, 78, 71]).buffer], { type: 'image/png' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'probe-blob.png';
  document.body.appendChild(a);
  a.click();
  await new Promise((res) => setTimeout(res, 800));
  return { href: a.href.slice(0, 40), clickHook: HTMLAnchorElement.prototype.click.toString().slice(0, 60) };
});
console.log('PROBE', JSON.stringify(r));
await wait(3000);
console.log('FILES', JSON.stringify(readdirSync(DIR)));

// 再看真实工具：提取图标后点下载
await page.goto(`${BASE}/tools/extractor/favicon-extractor.html`, { waitUntil: 'networkidle2', timeout: 60000 });
await wait(600);
await page.evaluate(() => {
  const el = document.getElementById('urlInput');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'baidu.com');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  [...document.querySelectorAll('button')].find((b) => /提取图标/.test(b.textContent)).click();
});
await page.waitForFunction(() => document.querySelectorAll('#iconsGrid .icon-card').length >= 5, { timeout: 45000 });
const clicked = await page.evaluate(() => {
  const card = [...document.querySelectorAll('#iconsGrid .icon-card')].find(
    (c) => (c.querySelector('.size')?.textContent || '').trim() === '32x32' && /本机生成/.test(c.querySelector('.type')?.textContent || ''),
  );
  const btn = [...card.querySelectorAll('button')].find((b) => /下载/.test(b.textContent));
  btn.click();
  return (document.getElementById('toast')?.textContent || '').trim();
});
console.log('TOAST', JSON.stringify(clicked));
await wait(4000);
console.log('FILES2', JSON.stringify(readdirSync(DIR)));
for (const n of readdirSync(DIR)) {
  const buf = readFileSync(path.join(DIR, n));
  console.log('FILE', n, buf.length, buf.subarray(0, 4).toString('hex'));
}
await page.close();
await browser.disconnect();
