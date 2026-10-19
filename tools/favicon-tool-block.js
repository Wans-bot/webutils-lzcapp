// 懒猫微服补丁块：替换上游「网站图标提取器」的 extractFavicons / displayResults / downloadIcon。
//
// 为什么要换实现（官审 20636 驳回点）：
//   1. 上游只把图标地址丢进 window.open()，从不落盘；
//   2. 上游的图标来自 Google / DuckDuckGo 的 favicon 服务，跨域读不到字节，
//      而且在境内网络里这两个服务根本不可达（本机实测：盒子直连 12s 超时，百度可达）。
//      结果是「下载」必然拿不到文件，图标本身也经常加载失败。
//
// 现在的做法：图标一律经本应用的同源代理（lzc-manifest.yml 的 wu-favicon-proxy）取字节，
// 数据源改成站点自己声明的图标（link rel=icon / apple-touch-icon / favicon.ico），
// 由本机把取到的图标渲染成 16/32/48/64 四种尺寸；「下载」存的是内存里已有的 blob，
// 下载阶段不再依赖任何第三方站点，因此不会静默失败。

// ── 提示层 ──────────────────────────────────────────────────────────────────
// 上游页面只有 .toast 样式，HTML 里没有 #toast 元素，所以它的 showToast() 一调用就抛
// "TypeError: Cannot set properties of null"（复制链接、下载都会触发）。这里补上元素。
function ensureToastElement() {
  let toast = document.getElementById("toast");
  if (toast) return toast;
  toast = document.createElement("div");
  toast.id = "toast";
  toast.className = "toast";
  document.body.appendChild(toast);
  return toast;
}

function wuToast(message, type) {
  const toast = ensureToastElement();
  toast.textContent = message;
  toast.style.background = type === "error" ? "#ef4444" : "#10b981";
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), type === "error" ? 4000 : 2500);
}

if (document.body) ensureToastElement();
else document.addEventListener("DOMContentLoaded", ensureToastElement, { once: true });

// ── 同源代理工具 ────────────────────────────────────────────────────────────
const FAVICON_PROXY_PREFIX = "/__favicon_proxy";
const OUTPUT_SIZES = [16, 32, 48, 64];

function proxyUrl(externalUrl) {
  try {
    const u = new URL(externalUrl, location.href);
    if (u.origin === location.origin) return u.pathname + u.search;
    return FAVICON_PROXY_PREFIX + "/" + u.host + u.pathname + u.search;
  } catch (e) {
    return externalUrl;
  }
}

async function proxyFetch(externalUrl, as) {
  const res = await fetch(proxyUrl(externalUrl), { credentials: "same-origin", cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  if (as === "text") return await res.text();
  return await res.blob();
}

function loadImageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve({ img: img, objectUrl: objectUrl });
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("图标文件无法解码"));
    };
    img.src = objectUrl;
  });
}

// 站点自己声明的图标（按 sizes 从大到小），最后兜底两个约定路径。
// 注意：很多站点（如 baidu.com）裸域会 301 到 www，跨域跳转会让 fetch 直接失败，
// 所以同时试 www.<domain> 与 <domain>，谁先取到图标就用谁。
function hostVariants(domain) {
  const list = [];
  if (domain.indexOf("www.") !== 0) list.push("www." + domain);
  list.push(domain);
  return list;
}

async function collectCandidatesForHost(host) {
  const list = [];
  try {
    const html = await proxyFetch("https://" + host + "/", "text");
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const link of doc.querySelectorAll("link[rel][href]")) {
      const rel = String(link.getAttribute("rel") || "").toLowerCase();
      if (!/(^|\s)(icon|shortcut icon|apple-touch-icon|apple-touch-icon-precomposed)(\s|$)/.test(rel)) continue;
      const sizes = String(link.getAttribute("sizes") || "");
      const declared = /(\d+)x(\d+)/i.exec(sizes);
      let href = link.getAttribute("href");
      try {
        href = new URL(href, "https://" + host + "/").href;
      } catch (e) {
        continue;
      }
      list.push({
        url: href,
        declaredW: declared ? Number(declared[1]) : 0,
        hint: rel + (sizes ? " " + sizes : ""),
      });
    }
  } catch (e) {
    // 首页取不到（不是 HTML / 打不开）时继续用约定路径，不在这里失败
  }
  list.sort((a, b) => b.declaredW - a.declaredW);
  list.push({ url: "https://" + host + "/favicon.ico", declaredW: 0, hint: "favicon.ico" });
  list.push({ url: "https://" + host + "/apple-touch-icon.png", declaredW: 0, hint: "apple-touch-icon.png" });
  return list;
}

function extensionForMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.indexOf("svg") >= 0) return "svg";
  if (m.indexOf("icon") >= 0 || m.indexOf("ico") >= 0) return "ico";
  if (m.indexOf("jpeg") >= 0) return "jpg";
  if (m.indexOf("webp") >= 0) return "webp";
  if (m.indexOf("gif") >= 0) return "gif";
  return "png";
}

function safeDomainTag(domain) {
  return String(domain || "site").replace(/[^A-Za-z0-9.-]+/g, "_");
}

// 由原始图标渲染出 16/32/48/64 四种尺寸（canvas 在同源 blob 上不会污染，可以导出 PNG）
async function buildSizeCards(domain, img, width, height, sourceUrl, originalMime) {
  const cards = [];
  const tag = safeDomainTag(domain);
  for (const size of OUTPUT_SIZES) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    const scale = Math.min(size / width, size / height);
    const drawW = Math.max(1, Math.round(width * scale));
    const drawH = Math.max(1, Math.round(height * scale));
    ctx.drawImage(img, Math.round((size - drawW) / 2), Math.round((size - drawH) / 2), drawW, drawH);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) continue;
    cards.push({
      label: size + "x" + size,
      type: "本机生成 PNG",
      fileName: "favicon-" + tag + "-" + size + "x" + size + ".png",
      blobUrl: URL.createObjectURL(blob),
      sourceUrl: sourceUrl,
      mime: "image/png",
      originalMime: originalMime,
    });
  }
  return cards;
}

async function extractFavicons() {
  const input = document.getElementById("urlInput").value.trim();
  if (!input) {
    showError("请输入网站地址");
    return;
  }
  const domain = getDomain(input);

  document.getElementById("loading").classList.add("show");
  document.getElementById("result").style.display = "none";
  document.getElementById("errorMsg").style.display = "none";

  try {
    const seen = {};
    const tried = [];
    let source = null;
    // 按 host 变体逐个试；某个变体取到图标就停，不再打另一个变体（避免无谓的失败请求）
    for (const host of hostVariants(domain)) {
      const candidates = await collectCandidatesForHost(host);
      for (const candidate of candidates) {
        if (seen[candidate.url]) continue;
        seen[candidate.url] = true;
        try {
          const blob = await proxyFetch(candidate.url);
          if (!blob.size) throw new Error("空文件");
          const loaded = await loadImageFromBlob(blob);
          source = { candidate: candidate, blob: blob, img: loaded.img, objectUrl: loaded.objectUrl };
          break;
        } catch (e) {
          tried.push(candidate.url.replace(/^https:\/\//, "") + " → " + (e && e.message ? e.message : e));
        }
      }
      if (source) break;
    }
    if (!source) {
      throw new Error("没有取到可用图标（" + tried.slice(0, 3).join("；") + "）");
    }

    const width = source.img.naturalWidth || source.img.width || 0;
    const height = source.img.naturalHeight || source.img.height || 0;
    if (!width || !height) throw new Error("图标尺寸为 0");

    const cards = await buildSizeCards(domain, source.img, width, height, source.candidate.url, source.blob.type);
    if (!cards.length) throw new Error("无法生成图标尺寸");

    document.getElementById("loading").classList.remove("show");
    displayResults(domain, {
      cards: cards,
      mainIconUrl: source.objectUrl,
      original: {
        label: width + "x" + height + "（原始）",
        type: "原始文件（" + source.candidate.hint + "）",
        fileName: "favicon-" + safeDomainTag(domain) + "-original." + extensionForMime(source.blob.type),
        blobUrl: source.objectUrl,
        sourceUrl: source.candidate.url,
        mime: source.blob.type || "image/x-icon",
      },
      width: width,
      height: height,
      sourceUrl: source.candidate.url,
    });
  } catch (e) {
    showError("提取图标失败：" + (e && e.message ? e.message : e));
  }
}

function displayResults(domain, data) {
  document.getElementById("siteName").textContent = domain;
  document.getElementById("siteUrl").textContent = "https://" + domain;

  const mainIcon = document.getElementById("mainIcon");
  mainIcon.removeAttribute("data-fallback");
  mainIcon.src = data.mainIconUrl;

  // 下载列表：先原始文件，再 16/32/48/64
  window.__wuFaviconCards = [data.original].concat(data.cards);

  // 用 DOM API 拼卡片，避免把外部内容当 HTML 注入
  const grid = document.getElementById("iconsGrid");
  grid.textContent = "";
  window.__wuFaviconCards.forEach((card, i) => {
    const cardEl = document.createElement("div");
    cardEl.className = "icon-card";

    const preview = document.createElement("div");
    preview.className = "icon-preview checker";
    const img = document.createElement("img");
    img.src = card.blobUrl;
    img.alt = "favicon";
    img.addEventListener("error", () => {
      const placeholder = document.createElement("span");
      placeholder.className = "placeholder";
      placeholder.textContent = "加载失败";
      preview.textContent = "";
      preview.appendChild(placeholder);
    });
    preview.appendChild(img);

    const info = document.createElement("div");
    info.className = "icon-info";
    const sizeEl = document.createElement("div");
    sizeEl.className = "size";
    sizeEl.textContent = card.label;
    const typeEl = document.createElement("div");
    typeEl.className = "type";
    typeEl.textContent = card.type;
    info.appendChild(sizeEl);
    info.appendChild(typeEl);

    const actions = document.createElement("div");
    actions.className = "icon-actions";
    const copyBtn = document.createElement("button");
    copyBtn.className = "secondary outline";
    copyBtn.textContent = "复制链接";
    copyBtn.addEventListener("click", () => window.copyUrl(card.sourceUrl));
    const downloadBtn = document.createElement("button");
    downloadBtn.textContent = "下载";
    downloadBtn.addEventListener("click", () => window.downloadIcon(i));
    actions.appendChild(copyBtn);
    actions.appendChild(downloadBtn);

    cardEl.appendChild(preview);
    cardEl.appendChild(info);
    cardEl.appendChild(actions);
    grid.appendChild(cardEl);
  });

  document.getElementById("result").style.display = "block";
}

// 真正把图标存成文件：字节在提取阶段就已经在本机内存里，下载这一步不再访问任何第三方站点。
//   普通浏览器 → 直接落盘；懒猫客户端 → 官方 open-save-chooser 注入接管 blob 链接，弹出网盘保存框。
window.downloadIcon = function (index) {
  const cards = window.__wuFaviconCards || [];
  const card = cards[index];
  if (!card) {
    wuToast("没有可保存的图标，请重新提取", "error");
    return;
  }
  try {
    const a = document.createElement("a");
    a.href = card.blobUrl;
    a.download = card.fileName;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 120000);
    wuToast("已开始保存 " + card.fileName + "（可存到懒猫网盘）");
  } catch (e) {
    wuToast("保存失败：" + (e && e.message ? e.message : e) + "；可改用「复制链接」", "error");
  }
};
