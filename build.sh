#!/usr/bin/env bash
# 拉取上游 html-tools 的固定 tag，把静态站点组装进 content/dist。
# 上游仓库根目录即为 Web 根，无需 npm 构建（index.html / tools/ / assets/ 都是成品）。
set -euo pipefail

UPSTREAM="${WEBUTILS_UPSTREAM:-https://github.com/chicogong/html-tools.git}"
TAG="${WEBUTILS_TAG:-v2.2.0}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HERE/content/dist"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "[build.sh] clone $UPSTREAM @ $TAG"
git clone --quiet --depth 1 --branch "$TAG" "$UPSTREAM" "$TMP/src"

mkdir -p "$DEST"
find "$DEST" -mindepth 1 -delete

# 只搬运行时需要的静态资源，排除开发/CI/审计产物
tar -C "$TMP/src" \
    --exclude='./.git' --exclude='./.github' --exclude='./node_modules' \
    --exclude='./tests' --exclude='./scripts' --exclude='./archive' \
    --exclude='./docs' --exclude='./screenshots' --exclude='./audit-report.json' \
    --exclude='./package.json' --exclude='./package-lock.json' \
    --exclude='./playwright.config.js' --exclude='./eslint.config.js' \
    --exclude='./.prettierrc' --exclude='./.prettierignore' \
    --exclude='./.stylelintrc.json' --exclude='./.htmlhintrc' \
    --exclude='./vercel.json' --exclude='./netlify.toml' \
    --exclude='./.gitignore' --exclude='./.gitattributes' \
    --exclude='./.gitleaksignore' --exclude='./.git-blame-ignore-revs' \
    --exclude='*.md' \
    -cf - . | tar -C "$DEST" -xf -

test -f "$DEST/index.html" || { echo "[build.sh] 上游缺少 index.html，构建中止" >&2; exit 1; }

echo "[build.sh] dist: $(find "$DEST" -type f | wc -l) 个文件，$(du -sh "$DEST" | cut -f1)"
