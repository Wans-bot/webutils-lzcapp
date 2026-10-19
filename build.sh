#!/usr/bin/env bash
# WebUtils（在线工具集）LPK 构建脚本。
#
# 流程：拉取固定上游 commit → 组装静态站点到 content/dist → 镜像外部 CDN 与字体 →
# 改写页面引用为本地路径 → 打「网站图标提取器」下载修正补丁 → 自检产物。
# 同一 commit + 同一镜像映射 → 同一 dist 树。
#
# 上游仓库：https://github.com/chicogong/html-tools （MIT）
#
# 为什么需要「图标提取器」补丁：上游 tools/extractor/favicon-extractor.html 的
# 「下载」按钮只是 window.open(第三方图标外链)，既不落盘也不受平台保存框接管，
# 在客户端拦外链导航/无外网的评审机上表现为点了没反应（官审 20636 驳回点之一）。
# 补丁把图标改走本应用同源代理（lzc-manifest.yml 的 wu-favicon-proxy），
# 「下载」变成 fetch → blob → <a download>，普通浏览器直接落盘、懒猫客户端弹出网盘保存框。
set -euo pipefail

REPO="chicogong/html-tools"
# 固定 commit：上游 release tag v2.2.0（提交时间 2026-08-26）
COMMIT="5f7d13484498cd25352d29660783fa2bfc3a9d02"
TARBALL_URL="https://codeload.github.com/${REPO}/tar.gz/${COMMIT}"
EXPECTED_SHA256="80b24047877e906f6a159040d81d7a0f7f61f948ae750484c73f678420758ae7"

WORK=".build/upstream"
SRC="${WORK}/src"
OUT="content/dist"

rm -rf "${WORK}"
mkdir -p "${WORK}" "${OUT}"

echo "==> 拉取 ${TARBALL_URL}"
curl -fsSL --retry 3 --retry-delay 2 -o "${WORK}/src.tgz" "${TARBALL_URL}"
got_sha="$(sha256sum "${WORK}/src.tgz" | awk '{print $1}')"
echo "==> 上游 tarball sha256: ${got_sha}"
if [ "${got_sha}" != "${EXPECTED_SHA256}" ]; then
    echo "ERROR: 上游 tarball sha256 与固定值不一致" >&2
    exit 1
fi

mkdir -p "${SRC}"
tar -xzf "${WORK}/src.tgz" -C "${SRC}" --strip-components=1

echo "==> 组装静态站点到 ${OUT}"
rm -rf "${OUT}"
mkdir -p "${OUT}"

# 站点文件（上游仓库根目录即 Web 根）。不含测试、脚本、站点验证文件与开发配置。
for p in \
    index.html tools.json manifest.json robots.txt sitemap.xml llms.txt \
    offline.html sw.js _headers _redirects \
    favicon.svg favicon-16x16.png favicon-32x32.png apple-touch-icon.png social-preview.png \
    assets i18n tools docs \
    LICENSE NOTICE \
    ; do
    if [ -e "${SRC}/${p}" ]; then
        cp -a "${SRC}/${p}" "${OUT}/"
    else
        echo "    note: 上游缺少 ${p}"
    fi
done

echo "==> 镜像外部 CDN 资源与字体"
# 本机构建机无 IPv6 路由：node 侧统一优先解析 IPv4
export NODE_OPTIONS="${NODE_OPTIONS:-} --dns-result-order=ipv4first"
node tools/mirror-assets.mjs "${OUT}" .build/vendor-lock.json
cp .build/vendor-lock.json ./vendor-lock.json

echo "==> 改写页面引用为本地路径"
node tools/patch-refs.mjs "${OUT}" .build/vendor-lock.json

echo "==> 打「网站图标提取器」下载修正补丁（同源代理 + 真正落盘）"
node tools/patch-favicon-tool.mjs "${OUT}"

echo "==> 校验产物"
test -f "${OUT}/index.html" || { echo "ERROR: 缺少 index.html" >&2; exit 1; }
test -f "${OUT}/tools.json" || { echo "ERROR: 缺少 tools.json" >&2; exit 1; }
test -f "${OUT}/assets/fonts/fonts.css" || { echo "ERROR: 缺少本地字体 css" >&2; exit 1; }
grep -q "__favicon_proxy" "${OUT}/tools/extractor/favicon-extractor.html" || {
    echo "ERROR: 图标提取器补丁未生效" >&2; exit 1; }
! grep -q "window.open(url, \"_blank\")" "${OUT}/tools/extractor/favicon-extractor.html" || {
    echo "ERROR: 图标提取器仍在使用 window.open 下载" >&2; exit 1; }
echo "    页面 $(find "${OUT}" -name '*.html' | wc -l) 个，文件 $(find "${OUT}" -type f | wc -l) 个，$(du -sh "${OUT}" | cut -f1)"
