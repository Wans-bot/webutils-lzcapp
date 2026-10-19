# WebUtils 在线工具集 · 官审 20636 驳回点返工验收报告

- 包名：`cloud.lazycat.app.webutils`（v2.2.0-2，版本号未改）
- 上游：`chicogong/html-tools` tag `v2.2.0` = commit `5f7d13484498cd25352d29660783fa2bfc3a9d02`（MIT）
- 驳回原文（审核单 #20636）：**「manifest中作者名称需要与github作者名称保持一致, 网站图标提取器工具,无法下载提取的图标」**
- 验收环境：盒子 lzcos（`ssh lzcbox`，192.168.31.44）真机 https，Chrome 146 无头 + CDP，zh-CN；评审式链路 = 盒子 host 网络 nginx（127.0.0.5:443，补 `Lzc-Api-Auth-Token`）→ lzc-ingress → 应用

---

## 一、结论

| 驳回点 | 状态 | 关键证据 |
| --- | --- | --- |
| 作者名与 GitHub 作者一致 | ✅ 已改 | `package.yml:5` → `author: chicogong`（`homepage` 本就是 `github.com/chicogong/html-tools`） |
| 网站图标提取器的「下载」拿不到文件 | ✅ 已根因修复 | 真机 https 下点「下载」：客户端形态弹出「保存至懒猫」网盘保存框且文件名正确（16/32/48/64 各一次）；无平台注入时浏览器真的落盘 4 个 PNG，字节数与 sha256 见第四节 |

真机验收：**图标下载专项 27/27 通过**，**全量回归 20/20 通过**；应用自身 console 错误 / pageerror / 失败请求均为 0。

---

## 二、驳回点 1：manifest 作者名

| 位置 | 改动前 | 改动后 |
| --- | --- | --- |
| `package.yml:5` | `author: chico` | `author: chicogong` |
| `package.yml:7` | `homepage: https://github.com/chicogong/html-tools` | 不变（本来就与上游一致） |
| `package.yml` 的 `locales.*` | 无 `chico` 字样（已全量 grep 确认） | 不变 |
| `build.sh:6` | 上游地址已是 `github.com/chicogong/html-tools.git` | 不变 |

本包是**移植上游**，因此作者字段以上游 GitHub 作者名 `chicogong` 为准，不是移植者自己的名字。
仓库内除 `package.yml` 外没有其它地方写作者名（`grep -rn chico` 仅命中 `package.yml` 与 `build.sh` 的上游 URL）。

> 待主控处理：开发者中心已登记的应用资料里 `source` / `source_author` 需同步为上游仓库与 `chicogong`（本任务只改仓库内文件，未动登记信息）。

---

## 三、驳回点 2：图标「下载」的实测根因

### 3.1 上游实现（v2.2.0 `tools/extractor/favicon-extractor.html`）

```js
window.downloadIcon = async function (url, domain, index) {
  try {
    // Open in new tab for download since we can't directly download cross-origin
    window.open(url, "_blank");
    showToast("已在新标签页打开，右键保存图片");
  } catch (e) {
    showToast("下载失败，请右键图片另存为", "error");
  }
};
```

**一句话根因**：这个「下载」按钮根本不下载——它只是把第三方图标外链（`https://www.google.com/s2/favicons?...` / `https://icons.duckduckgo.com/ip3/...`）丢进 `window.open`，
跨域链接的 `download` 属性无效、客户端又会拦外链导航/弹窗，所以评审看到的是「点了没反应」；即使在新标签页打开也拿不到文件。

### 3.2 实测证据（不是照抄猜测）

1. **源码级**：上述函数无任何 `blob` / `download` / 写盘动作；`displayResults()` 里图标地址是 Google/DuckDuckGo 外链，`<img src>` 直接跨域加载。
2. **网络级**：盒子（境内网络）直连两个图标服务全部超时——即使把 `window.open` 换成服务端代理也救不回来：

   ```
   box→ https://www.google.com/s2/favicons?domain=baidu.com&sz=64   → curl (28) timed out 12s
   box→ https://icons.duckduckgo.com/ip3/baidu.com.ico              → curl (28) timed out 12s
   box→ https://www.baidu.com/favicon.ico                           → HTTP 200  image/x-icon  16958 B
   box→ https://github.com/favicon.ico                              → HTTP 200  image/x-icon   6518 B
   ```
3. **浏览器级**（本链路复现）：点「下载」不产生任何下载事件、不产生文件，页面只出现「已在新标签页打开，右键保存图片」提示；`Page.setDownloadBehavior` 下也没有 `downloadWillBegin`。
4. **额外缺陷（顺带修掉）**：该页面 HTML 里没有 `#toast` 元素，只有 `.toast` 样式，`showToast()` 一调用就抛
   `TypeError: Cannot set properties of null (setting 'textContent')` ——「复制链接」「下载」都会踩到（真机 pageerror 实测捕获）。

### 3.3 改法（最小改动 + 平台正规通道）

1. **同源代理（`lzc-manifest.yml` 新增 request 注入 `wu-favicon-proxy`）**
   `/__favicon_proxy/<目标主机><目标路径>?<原始 query>` → `ctx.proxy.to("https://" + host, …)` 原样回传字节。
   安全边界：只放 `GET/HEAD`；目标必须是公网域名（拒绝 IP 字面量、`localhost`/`*.local`/`*.internal` 等内网名）；路径不许含 `..`；不外带 `Cookie`/`Authorization`/`Origin`/`Referer`。
2. **重定向改写（`lzc-manifest.yml` 新增 response 注入 `wu-favicon-proxy-redirect`）**
   上游 `Location` 是绝对外链（例：`baidu.com → www.baidu.com`），浏览器跟随时会变成跨域请求并 `ERR_FAILED`；该注入把 3xx 的 `Location` 改写成同源 `/__favicon_proxy/<host><path>`，重定向仍在代理内完成。
3. **页面逻辑重写（构建期补丁：`tools/patch-favicon-tool.mjs` + `tools/favicon-tool-block.js`）**
   - 图标数据源改为**站点自己声明的图标**：`<link rel=icon|shortcut icon|apple-touch-icon>` → 兜底 `/favicon.ico`、`/apple-touch-icon.png`，并同时尝试 `www.<domain>` 与 `<domain>`（很多站点裸域会 301 到 www）；
   - 取到的字节在本机用 canvas 生成 **16/32/48/64** 四种尺寸 PNG（同源 blob 不污染画布，可导出）；
   - 「下载」= 内存里已有 blob → `<a download>` 点击：**普通浏览器直接落盘；懒猫客户端由官方 `open-save-chooser` 注入接管成「保存至懒猫」网盘保存框**，下载阶段不再访问任何第三方站点，因此不会静默失败；
   - 「复制链接」保留站点真实图标地址；失败时给出明确原因（HTTP 状态/网络），不留会静默失败的按钮；
   - 顺手补上缺失的 `#toast` 元素，消除上游 `showToast` 的 pageerror。
4. **构建链路（`build.sh` / `tools/*.mjs`）**
   - `build.sh` 恢复并固化：固定 commit tarball（sha256 校验）→ 组装 → 镜像外部 CDN/字体 → 改写引用 → **打图标提取器补丁** → 产物自检（补丁未生效或有残留 `window.open` 直接失败）；
   - `tools/mirror-assets.mjs`：每次抓取加 20s 硬超时（CDN 被黑洞时不会挂十几分钟）；cdnjs/unpkg 直连失败时按同一版本从 unpkg / npm registry tarball 兜底；字体本地文件名清洗（Google 旧版 `l/font?kit=…` 地址原本会落成带 `?` 的文件名，静态路由取不到 → 控制台 `Failed to decode downloaded font`）。
5. **没有做的事**：未改版本号、未改镜像（本包无镜像）、未 push、未提审、未动其它应用。

---

## 四、验收：真机 https 下的「下载」证据

链路：盒子无头 Chrome 146 → nginx(127.0.0.5:443, TLS + `Lzc-Api-Auth-Token`) → lzc-ingress → 应用（`https://webutils.wans.heiyu.space`）。测试域名 `baidu.com`。

### 4.1 A. 平台注入上下文（客户端真实形态）

`node tools/box-favicon-accept.mjs …` → `acceptance/favicon-accept.json`（27/27 通过）。逐项摘要：

| 项 | 结果 | 证据 |
| --- | --- | --- |
| A0 官方网盘选择器已注册 | PASS | `customElements.get('lzc-file-picker')=true` |
| A1 提取出 4 张尺寸图 + 原始文件 | PASS | 卡片：`64x64（原始）[原始文件(shortcut icon)]`、`16x16`、`32x32`、`48x48`、`64x64` |
| A2 每张卡片的下载载荷都是可解码图片 | PASS | 原始 16958 B 64x64 ｜ 16x16 762 B ｜ 32x32 1674 B ｜ 48x48 3057 B ｜ 64x64 3259 B |
| A3 生成尺寸与标签一致 | PASS | `16x16→16x16 32x32→32x32 48x48→48x48 64x64→64x64` |
| A4 复制链接目标仍是站点真实图标地址 | PASS | `https://www.baidu.com/favicon.ico` |
| A5-16x16 点「下载」弹出网盘保存框且文件名正确 | PASS | `filepicker2?props={"saveNames":["favicon-baidu.com-16x16.png"],"title":"保存至懒猫","type":"saveAs"}` |
| A5-32x32 | PASS | `saveNames:["favicon-baidu.com-32x32.png"]` |
| A5-48x48 | PASS | `saveNames:["favicon-baidu.com-48x48.png"]` |
| A5-64x64 | PASS | `saveNames:["favicon-baidu.com-64x64.png"]` |
| A6 复制链接仍可用 | PASS | 复制到 `https://www.baidu.com/favicon.ico` |
| A7/A8/A9 应用自身 console / pageerror / 失败请求 | PASS | 0 / 0 / 0（另有 4 条平台组件噪音，见第五节） |

截图：`shots/pc-11-favicon-extracted.png`（提取结果）、`shots/pc-12-download-16x16.png`（点下载后弹「保存至懒猫」，文件名 `favicon-baidu.com-16x16.png`）、`pc-12-download-{32x32,48x48,64x64}.png`。

### 4.2 B. 普通浏览器上下文（无平台保存框，浏览器真的落盘）

对照手段：`evaluateOnNewDocument` 拦掉 `lzc-file-picker` 的注册（等价于没有懒猫客户端注入），用 CDP `Browser.setDownloadBehavior` 指定下载目录；下载目录挂在盒子上（`/root/wu-tkt/downloads/plain`），脚本用 ssh 取回字节本地校验。

| 文件（盒子路径 → 本地副本） | 字节数 | sha256 | PNG |
| --- | --- | --- | --- |
| `/root/wu-tkt/downloads/plain/favicon-baidu.com-16x16.png` → `acceptance/downloads/plain/` | 762 | `9251aae5efe045a952e59adbf16fe4c5dd22ed9f809f9fc07e4bcb4d108cb05f` | PNG 16x16 bitDepth 8 |
| `…/favicon-baidu.com-32x32.png` | 1674 | `cc50ab92ac1605ed1052a9d40ff2b32e7f5472266885419f7cd8e9d4f7dbdf5d` | PNG 32x32 bitDepth 8 |
| `…/favicon-baidu.com-48x48.png` | 3057 | `e930550bf30d5502591a1e58d88329fdc347ad22f4fa9c9820195251c2bb956b` | PNG 48x48 bitDepth 8 |
| `…/favicon-baidu.com-64x64.png` | 3259 | `fdcebbb298dbc4fcfebdf41489cdfd19f31f778ac7884ce5e075756e4c382cf3` | PNG 64x64 bitDepth 8 |
| 回归：`…/decoded_image.png`（Base64 图片工具） | 100 | `856fc5c4a6ac1ae9316a4c200513997d3194881f734193ffb6122a7c0d819a1d` | PNG |
| 回归：`…/icon_64x64.png`（ICO 查看器） | 3259 | `fdcebbb298dbc4fcfebdf41489cdfd19f31f778ac7884ce5e075756e4c382cf3` | PNG 64x64 |

四个尺寸与 A 上下文的载荷字节数一一对应（762 / 1674 / 3057 / 3259），说明客户端保存框拿到的就是同一份字节。
截图：`shots/pc-20-favicon-plain-browser.png`、`shots/pc-21-favicon-downloads.png`、`shots/pc-22-regression-tools.png`。

### 4.3 截图清单

- PC 1920×1080：`pc-01-hub`、`pc-02-tool-grid`、`pc-03-json-formatter`、`pc-04-qrcode`、`pc-05-netdisk-picker`、`pc-10-favicon-before`、`pc-11-favicon-extracted`、`pc-12-download-16x16/32x32/48x48/64x64`、`pc-20-favicon-plain-browser`、`pc-21-favicon-downloads`、`pc-22-regression-tools`（共 14 张）
- 移动视口 390×844 @dsf2（780×1688）：`mobile-01-hub`、`mobile-02-tool`、`mobile-03-netdisk`

---

## 五、失败请求 / 台面报错清单

| 上下文 | 应用自身 console 错误 | 应用自身 pageerror | 应用自身失败请求 |
| --- | --- | --- | --- |
| A（平台注入） | 0 | 0 | 0 |
| B（普通浏览器） | 0 | 0 | 0 |
| 全量回归（`tools/box-accept.mjs`） | 0 | 0 | 0 |

**第三方/链路噪音（不计入应用，逐条列明）**：

1. `WebSocket connection to 'wss://file.wans.heiyu.space/api/operation/fileManager/message?protocol=2' failed: HTTP Authentication failed` ×4（A 上下文）——平台网盘客户端需要真实客户端会话，本验收链路只有请求头票据，没有客户端 WebSocket 会话。
2. `Failed to load resource: … 401 (Unauthorized)`（`file.wans.heiyu.space`，全量回归 16 条）——同上，网盘/设备服务在无客户端会话时 401。
3. `LazyCat download picker failed. Error: HTTP 401`（偶发）——官方选择器在网盘组件 401 后重试路径打印，属平台注入自身日志。
4. `TypeError: Cannot read properties of null (reading 'contentWindow')`（`open-save-chooser_0.js`，偶发）——网盘 iframe 未就绪时平台脚本自身异常。
5. 站外请求：`file.wans.heiyu.space`（网盘 iframe）、`ai.wans.heiyu.space`（设备服务）——平台组件域名，非第三方 CDN。**无** Google/DuckDuckGo 等第三方图标服务请求（修复后不再依赖）。
6. 构建期仍保留的 2 处站外字面量（不在运行时加载）：`tools/dev/sri-hash-generator.html` 里 `https://cdn.jsdelivr.net/npm/...` 省略号占位示例；`assets/vendor/` 内一组库自带 cdnjs 回退地址（库自身逻辑）。

---

## 六、其它工具回归（确认没被这次改动破坏）

`tools/box-accept.mjs` 全量 20 项全通过（真机 https）：

首屏 1269 ms ／ zh-CN ／ 1088 张工具卡 ／ 平台注入送达并注册官方选择器 ／ 站外样式脚本 0 处 ／ 本地字体 `Space Grotesk` 生效 ／ JSON 格式化 ／ Base64 编码 ／ 注入幂等（重复注入 0 pageerror）／ 二维码生成 ／ 网盘选择器弹出并列出「全部文件/我的收藏/外接硬盘/他人共享/远程挂载/本地同步」／ 首页进工具页 ／ 移动端无横向溢出 ／ viewport ／ 刷新后本地状态保留 ／ 无外部 CDN 请求。

下载/上传专项回归（B 上下文，真落盘）：

- **Base64 图片工具**：粘贴 data URI → 解码成功 → 「下载图片」→ `decoded_image.png` 100 B 落盘。
- **ICO 查看器**：上传 `.ico`（16958 B）→ 解析出图标网格 → 「下载」→ `icon_64x64.png` 3259 B 落盘（与 favicon 工具 64x64 产物字节一致）。
- **图片压缩 / 文件选择类工具**：官方 `open-save-chooser` 仍在 `input[type=file]` 上生效（pc-05-netdisk-picker 截图 + 全量回归 B5）。

---

## 七、构建与产物

| 项 | 值 |
| --- | --- |
| `lzc-cli project lint` | `No manifest lint warnings found.` |
| 打包命令 | `lzc-cli project release -f ./lzc-build.yml -o ./dist/webutils.lpk` |
| LPK | `dist/webutils.lpk`，59893760 B（57.1 MiB） |
| LPK sha256 | `7fc91e4899b58b2b8d29e1f829e055bf736461373a551fa5d7e066154a50481f` |
| `lzc-cli lpk info` | `version: 2.2.0-2`、`lpk_version: v2`、`images: none`、`signed: no` |
| `lzc-cli lpk lint` | `No LPK lint warnings found.` |
| dist 规模 | 1124 个页面 / 1267 个文件 / 58 MB（与 2.2.0-1 归档一致） |
| 上游 tarball | sha256 `80b24047877e906f6a159040d81d7a0f7f61f948ae750484c73f678420758ae7`（build.sh 内校验） |
| 外部资源镜像 | 93/93 成功 + 2 个动态文件（sql.js），`vendor-lock.json` 留痕 |
| 安装 | `scp dist/webutils.lpk lzcbox:/root/wu.lpk && ssh lzcbox 'lpk-manager uninstall …; lpk-manager install /root/wu.lpk'` → `Install succeeded` |

---

## 八、遗留限制与风险

1. **图标来源变了（能力取舍）**：工具不再调用 Google/DuckDuckGo 的 favicon 服务，改为取站点自身声明的图标（`link rel=icon` / `apple-touch-icon` / `/favicon.ico`）并在本机生成 16/32/48/64。原因：这两个服务在境内网络不可达（盒子实测 12s 超时），依赖它们等于保留一个必然失败的按钮。代价：若目标站点完全不给 favicon（少见），工具会明确报「没有取到可用图标」而不是伪装成功。
2. **尺寸是重采样得到的**：16/32/48/64 由站点原始图标（如 baidu 的 64×64 `.ico`）在本机重采样；原始文件同时单独列出可下载（`favicon-<domain>-original.ico`）。若站点只提供 16×16，放大到 64×64 会不够锐利——这是数据源限制，不是下载失败。
3. **代理是「盒子代取」**：目标站点若只能从客户端网络访问（内网域名、需要登录的站点），代理会失败并给出 HTTP 状态；这是有意为之（拒绝 IP 字面量与内网名，避免把盒子当任意代理）。
4. **客户端保存框在验收链路里只能验证到「弹出 + 文件名/字节正确」**：本链路没有真实客户端会话，无法在 CI 式脚本里点完「保存」写到网盘目录；落盘证据用普通浏览器上下文 + 相同字节的 sha256 交叉印证（见 4.2）。真实客户端里点「保存」即写入网盘（平台组件行为，非本包代码）。
5. **移动端结论来自 390×844 视口模拟**，不是真机。
6. 构建依赖外网：上游 tarball（github codeload）+ 一个 npm registry + Google Fonts / cdnjs / unpkg 镜像；本轮已加 20s 超时与 unpkg/npm 兜底，但网络极差时仍可能重试失败（会明确报错退出，不会产出半成品包）。

---

## 九、复现命令

```bash
# 构建
cd /home/wans/rework/webutils
lzc-cli project lint
lzc-cli project release -f ./lzc-build.yml -o ./dist/webutils.lpk
sha256sum dist/webutils.lpk

# 装机 + 脚手架（TLS 前置 + 无头 Chrome，127.0.0.5:443 / CDP 9343）
scp dist/webutils.lpk lzcbox:/root/wu.lpk
ssh lzcbox 'lpk-manager uninstall cloud.lazycat.app.webutils; lpk-manager install /root/wu.lpk'
scp tools/wu-ticket-harness.sh lzcbox:/root/wu-tkt.sh && ssh lzcbox 'bash /root/wu-tkt.sh'
ssh -N -L 9343:127.0.0.1:9343 lzcbox &

# 验收（本地跑，驱动盒子上的 Chrome）
export PUPPETEER_CORE_DIR=/lzcapp/document/wans/lpk-skill/node_modules
node tools/box-favicon-accept.mjs https://webutils.wans.heiyu.space http://127.0.0.1:9343 acceptance
node tools/box-accept.mjs         https://webutils.wans.heiyu.space http://127.0.0.1:9343 acceptance/accept.json
node tools/box-shots.mjs          https://webutils.wans.heiyu.space http://127.0.0.1:9343 acceptance/shots

# 拆脚手架（拆/装应用前必须先 down，否则网络端点占住会报 has active endpoints）
ssh lzcbox 'export DOCKER_HOST=unix:///lzcsys/run/lzc-docker/docker.sock; lzc-docker rm -f wu-tkt-tls wu-tkt-chrome'
```

产物与证据：

- `dist/webutils.lpk`（sha256 见第七节）
- `acceptance/REPORT.md`（本文件）、`acceptance/accept.json`（全量回归 20/20）、`acceptance/favicon-accept.json`（图标下载专项 27/27）
- `acceptance/shots/`（PC 14 张 + 移动 3 张）、`acceptance/downloads/plain/`（落盘文件副本）
