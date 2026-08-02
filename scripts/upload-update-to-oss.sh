#!/usr/bin/env bash
# upload-update-to-oss.sh — 把 GitHub release 的桌面安装包同步到阿里云 OSS（国内更新源）
#
# 背景：tauri updater 的 latest.json 资产 url 指向 github.com，国内下载慢。
# 本脚本把同字节资产推送到 OSS（默认域名 HTTPS、免备案），并生成一份
# url 改写为 OSS 的 latest.json——客户端验签不受影响（minisign 签的是字节）。
#
# 用法（发布后跑一次，幂等）：
#   OSS_ACCESS_KEY_ID=xxx OSS_ACCESS_KEY_SECRET=yyy bash scripts/upload-update-to-oss.sh
# 可选环境变量：
#   OSS_BUCKET（默认 tianshu-update）  OSS_REGION（默认 cn-hangzhou）
#   OSSUTIL_BIN（默认 ossutil）        GH_REPO（默认 huiliyi37/Tianshu-Tui）
#   DRY_RUN=1 只拉取与生成、不上传（验证用）
#
# 一次性准备：
#   1. 控制台建 bucket：公共读、标准存储、region 与 OSS_REGION 一致、不开版本控制
#   2. RAM 子账号仅授该 bucket oss:PutObject/GetObject，取 AccessKey
#   3. 装 ossutil（https://github.com/aliyun/ossutil，brew install ossutil）
set -euo pipefail
cd "$(dirname "$0")/.."

BUCKET="${OSS_BUCKET:-tianshu-update}"
REGION="${OSS_REGION:-cn-hangzhou}"
OSSUTIL="${OSSUTIL_BIN:-ossutil}"
GH_REPO="${GH_REPO:-huiliyi37/Tianshu-Tui}"
DRY_RUN="${DRY_RUN:-0}"
OSS_BASE="https://${BUCKET}.oss-${REGION}.aliyuncs.com/tianshu"

VER="$(node -p "require('./latest.json').version")"
TAG="v${VER}"
echo "==> 同步 ${TAG} 到 oss://${BUCKET}/tianshu/（base: ${OSS_BASE}）"

command -v "$OSSUTIL" >/dev/null || { echo "✗ 未找到 ossutil——brew install ossutil 或见 https://github.com/aliyun/ossutil"; exit 1; }
command -v gh >/dev/null || { echo "✗ 未找到 gh CLI"; exit 1; }
if [ "$DRY_RUN" != "1" ]; then
  [ -n "${OSS_ACCESS_KEY_ID:-}" ] && [ -n "${OSS_ACCESS_KEY_SECRET:-}" ] || {
    echo "✗ 缺 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET（DRY_RUN=1 可跳过凭证只验证生成物）"; exit 1; }
fi

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

echo "==> 1/4 从 GitHub release 拉取资产"
gh release download "$TAG" --repo "$GH_REPO" --dir "$WORK" --pattern 'Tianshu_*' --clobber
EXPECTED=6
COUNT=$(find "$WORK" -maxdepth 1 -name 'Tianshu_*' -type f | wc -l | tr -d ' ')
[ "$COUNT" -ge "$EXPECTED" ] || { echo "✗ 资产数不足（期望 ≥${EXPECTED}：三平台安装包 + .sig，实得 ${COUNT}）"; ls -la "$WORK"; exit 1; }

echo "==> 2/4 生成 OSS 版 latest.json（url 改写）"
TAG="$TAG" OSS_BASE="$OSS_BASE" node -e '
const fs = require("fs");
const m = JSON.parse(fs.readFileSync("latest.json", "utf8"));
const ghBase = `https://github.com/huiliyi37/Tianshu-Tui/releases/download/${process.env.TAG}/`;
for (const [k, p] of Object.entries(m.platforms)) {
  if (!p.url.startsWith(ghBase)) { console.error(`✗ ${k} url 非预期基底: ${p.url}`); process.exit(1); }
  p.url = process.env.OSS_BASE + "/" + process.env.TAG + "/" + p.url.slice(ghBase.length);
}
fs.writeFileSync(process.argv[1], JSON.stringify(m, null, 2) + "\n");
console.log("  ✅ manifest 三平台 url 均已改写");
' "$WORK/latest-oss.json"

if [ "$DRY_RUN" = "1" ]; then
  echo "==> DRY_RUN：生成物在 $WORK（退出不清理请去掉 trap 查看）"; cat "$WORK/latest-oss.json" | head -8; trap - EXIT; echo "（目录保留：$WORK）"; exit 0
fi

echo "==> 3/4 上传资产（长缓存，不可变）"
"$OSSUTIL" cp -r "$WORK" "oss://${BUCKET}/tianshu/${TAG}/" \
  -i "$OSS_ACCESS_KEY_ID" -k "$OSS_ACCESS_KEY_SECRET" -e "oss-${REGION}.aliyuncs.com" \
  --include 'Tianshu_*' --meta 'Cache-Control:public, max-age=31536000, immutable' -f

echo "==> 4/4 上传 latest.json（no-cache）"
"$OSSUTIL" cp "$WORK/latest-oss.json" "oss://${BUCKET}/tianshu/latest.json" \
  -i "$OSS_ACCESS_KEY_ID" -k "$OSS_ACCESS_KEY_SECRET" -e "oss-${REGION}.aliyuncs.com" \
  --meta 'Cache-Control:no-cache' -f

echo "==> 验证"
curl -sfI "${OSS_BASE}/latest.json" | grep -iE '^HTTP|cache-control' || { echo "✗ manifest 不可达"; exit 1; }
echo "✅ 完成。国内 endpoint：${OSS_BASE}/latest.json"
echo "   发版提示：tauri.conf.json 的 endpoints 需随下次桌面端发版带出（配置打包在安装包内）"
