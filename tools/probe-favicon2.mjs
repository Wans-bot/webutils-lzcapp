#!/usr/bin/env node
// 排错探针 2：① 图标提取后读 window.__wuFaviconCards；② 点下载后看保存框 iframe 的 props；
// ③ 单独跑图片压缩的上传+下载，打印页面状态与 pageerror 来源。
import { loadPuppeteer } from '/lzcapp/document/wans/lpk-skill/scripts/lib/load-puppeteer.mjs';

const BASE = (process.argv[2] || 'https://webutils.wans.heiyu.space').replace(/\/$/, '');
const CDP = process.argv[3] || 'http://127.0.0.1:9343';
const puppeteer = await loadPuppeteer();
const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── A：图标提取 + 保存框 ─────────────────────────────────────────────────────
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
const errs = [];
page.on('pageerror', (e) => errs.push(`[pageerror] ${String(e).slice(0, 160)} || ${(e.stack || '').split('\n').slice(0, 3).join(' <- ')}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`[console] ${m.text().slice(0, 120)} @ ${m.location()?.url?.slice(0, 80)}`); });
await page.goto(`${BASE}/tools/extractor/favicon-extractor.html`, { waitUntil: 'networkidle2', timeout: 60000 });
await wait(600);
await page.evaluate(() => {
  const el = document.getElementById('urlInput');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'baidu.com');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  [...document.querySelectorAll('button')].find((b) => /提取图标/.test(b.textContent)).click();
});
await page.waitForFunction(() => document.querySelectorAll('#iconsGrid .icon-card').length > 0, { timeout: 30000 });
const cards = await page.evaluate(async () => {
  const out = [];
  for (const c of window.__wuFaviconCards || []) {
    let bytes = null;
    try { bytes = (await (await fetch(c.blobUrl)).blob()).size; } catch (e) { bytes = 'ERR ' + e.message; }
    out.push({ label: c.label, type: c.type, name: c.fileName, mime: c.mime, bytes, sourceUrl: c.sourceUrl });
  }
  return out;
});
console.log('CARDS', JSON.stringify(cards, null, 1));

// 点第一个「本机生成 PNG」的下载，记录 iframe URL 变化
const clickSize = async (size) => {
  const box = await page.evaluate((label) => {
    const card = [...document.querySelectorAll('#iconsGrid .icon-card')].find(
      (c) => (c.querySelector('.size')?.textContent || '').trim() === label && /本机生成/.test(c.querySelector('.type')?.textContent || ''),
    );
    if (!card) return null;
    const btn = [...card.querySelectorAll('button')].find((b) => /下载/.test(b.textContent));
    const r = btn.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, size);
  if (!box) return { size, err: 'no button' };
  await page.mouse.click(box.x, box.y);
  const found = [];
  for (let i = 0; i < 24; i++) {
    await wait(250);
    for (const f of page.frames()) if (/filepicker/.test(f.url()) && !found.includes(f.url())) found.push(f.url());
    if (found.length) break;
  }
  await page.keyboard.press('Escape');
  await wait(700);
  return { size, frames: found.map((u) => decodeURIComponent(u).slice(0, 220)) };
};
for (const size of ['16x16', '32x32', '64x64']) {
  console.log('DL', JSON.stringify(await clickSize(size)));
}
console.log('ERRS', JSON.stringify(errs.slice(0, 8), null, 1));
await page.close();

// ── B：图片压缩上传 + 下载 ──────────────────────────────────────────────────
const p2 = await browser.newPage();
await p2.setViewport({ width: 1600, height: 1000 });
const errs2 = [];
p2.on('pageerror', (e) => errs2.push(`[pageerror] ${String(e).slice(0, 200)}`));
p2.on('console', (m) => { if (m.type() === 'error') errs2.push(`[console] ${m.text().slice(0, 150)}`); });
await p2.goto(`${BASE}/tools/media/image-compressor.html`, { waitUntil: 'networkidle2', timeout: 60000 });
await wait(800);
const input = await p2.$('#fileInput');
await input.uploadFile('/home/wans/rework/webutils/acceptance/sample-upload.png');
for (let i = 0; i < 10; i++) {
  await wait(700);
  const st = await p2.evaluate(() => ({
    actions: document.getElementById('actionsCard')?.style.display,
    preview: document.getElementById('previewArea')?.style.display,
    savings: document.getElementById('savingsCard')?.style.display,
    upload: document.getElementById('uploadArea')?.style.display,
    toast: (document.getElementById('toast')?.textContent || '').trim(),
    err: (document.getElementById('errorMsg')?.textContent || '').trim(),
  }));
  console.log('IMG', i, JSON.stringify(st));
  if (st.actions === 'block' || st.actions === '') break;
}
console.log('ERRS2', JSON.stringify(errs2.slice(0, 6), null, 1));
await p2.close();
await browser.disconnect();
