#!/usr/bin/env node
// G4 商店截图：在盒子无头 Chrome 里走真实 https 域名，按固定视口与步骤出图。
// 用法：node tools/box-shots.mjs <baseUrl> <cdpUrl> <outDir>
//   例：node tools/box-shots.mjs https://webutils.wans.heiyu.space http://127.0.0.1:9336 out/shots

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadPuppeteer } from '/lzcapp/document/wans/lpk-skill/scripts/lib/load-puppeteer.mjs';

const BASE = (process.argv[2] || 'https://webutils.wans.heiyu.space').replace(/\/$/, '');
const CDP = process.argv[3] || 'http://127.0.0.1:9336';
const OUT = process.argv[4] || 'out/shots';
mkdirSync(OUT, { recursive: true });

const puppeteer = await loadPuppeteer();
const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });
const shots = [];

async function page(viewport) {
  const p = await browser.newPage();
  await p.setViewport(viewport);
  await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  return p;
}

async function shot(p, name, note) {
  const file = path.join(OUT, name + '.png');
  await p.screenshot({ path: file });
  shots.push({ file, note });
  console.log('shot', file, '-', note);
}

const setValue = (p, sel, v) => p.evaluate((s, val) => {
  const el = document.querySelector(s);
  if (!el) return false;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}, sel, v);

// ── 桌面 ──────────────────────────────────────────────────────────────────────
const pc = await page({ width: 1920, height: 1080 });
await pc.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise((r) => setTimeout(r, 2000));
await shot(pc, 'pc-01-hub', '首页：工具集与分类导航');

await pc.evaluate(() => window.scrollTo(0, 620));
await new Promise((r) => setTimeout(r, 900));
await shot(pc, 'pc-02-tool-grid', '首页：工具卡片网格');

await pc.goto(BASE + '/tools/dev/json-formatter.html', { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise((r) => setTimeout(r, 1200));
await setValue(pc, '#input', '{"name":"webutils","tags":["json","tools"],"ok":true}');
await pc.evaluate(() => document.querySelector('#btnFormat').click());
await new Promise((r) => setTimeout(r, 1200));
await shot(pc, 'pc-03-json-formatter', 'JSON 格式化工具：格式化结果');

await pc.goto(BASE + '/tools/generator/qrcode-generator.html', { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise((r) => setTimeout(r, 1200));
await setValue(pc, '#textInput', 'https://webutils.wans.heiyu.space');
await pc.evaluate(() => document.querySelector('#textInput').dispatchEvent(new Event('input', { bubbles: true })));
await new Promise((r) => setTimeout(r, 1500));
await shot(pc, 'pc-04-qrcode', '二维码生成工具：生成结果');

await pc.goto(BASE + '/tools/dev/base64.html', { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise((r) => setTimeout(r, 1200));
const box = await pc.evaluate(() => {
  const input = document.querySelector('#fileInput');
  const label = input ? document.querySelector(`label[for="${input.id}"]`) : null;
  const el = label || [...document.querySelectorAll('button,label')].find((n) => /选择文件/.test(n.textContent || ''));
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
});
if (box) await pc.mouse.click(box.x, box.y);
await new Promise((r) => setTimeout(r, 6000));
await shot(pc, 'pc-05-netdisk-picker', '选择文件：官方懒猫网盘选择器');
await pc.close();

// ── 移动端（viewport 模拟，记录中会标注为模拟验证）──────────────────────────
const mob = await page({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await mob.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise((r) => setTimeout(r, 2000));
await shot(mob, 'mobile-01-hub', '移动端视口首页');

await mob.goto(BASE + '/tools/dev/json-formatter.html', { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise((r) => setTimeout(r, 1200));
await setValue(mob, '#input', '{"mobile":true,"ok":1}');
await mob.evaluate(() => document.querySelector('#btnFormat').click());
await new Promise((r) => setTimeout(r, 1200));
await shot(mob, 'mobile-02-tool', '移动端视口工具页');

await mob.goto(BASE + '/tools/dev/base64.html', { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise((r) => setTimeout(r, 1200));
const mbox = await mob.evaluate(() => {
  const input = document.querySelector('#fileInput');
  const label = input ? document.querySelector(`label[for="${input.id}"]`) : null;
  const el = label || [...document.querySelectorAll('button,label')].find((n) => /选择文件/.test(n.textContent || ''));
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
});
if (mbox) await mob.mouse.click(mbox.x, mbox.y);
await new Promise((r) => setTimeout(r, 6000));
await shot(mob, 'mobile-03-netdisk', '移动端视口：网盘选择器');
await mob.close();

await browser.disconnect();
writeFileSync(path.join(OUT, 'shots.json'), JSON.stringify({ base: BASE, at: new Date().toISOString(), shots }, null, 1));
console.log(`共 ${shots.length} 张，清单写入 ${OUT}/shots.json`);
