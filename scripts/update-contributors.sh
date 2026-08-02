#!/usr/bin/env bash
# update-contributors.sh — 从 git 历史提取外部贡献者，更新 CONTRIBUTORS.md。
#
# 扫描两类来源：
#   1. GitHub 直接合并的 PR（"Merge PR #N" 格式的 merge commit）
#   2. 经 sync 流程并入的 PR（本地 pr-N 分支，代码在 dev repo 合入后同步到公开仓）
#
# 使用前先 fetch 所有 PR 分支：
#   for n in $(seq 1 50); do git fetch origin "pull/$n/head:pr-$n" 2>/dev/null; done
#
# 排除仓库拥有者（huiliyi37）。每位作者关联其涉及的 PR 编号。

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT="$REPO_DIR/CONTRIBUTORS.md"
OWNER="huiliyi37"

cd "$REPO_DIR"

declare -A AUTHOR_PRS   # "Name <email>" → " #1 #3 #7"
declare -A PR_TITLES    # PR number → short title

# ── 来源 1：GitHub 直接合并的 PR ──

while IFS=$'\t' read -r hash subject; do
  pr_num=$(echo "$subject" | sed -n 's/.*Merge PR #\([0-9]*\).*/\1/p')
  [ -z "$pr_num" ] && continue
  # 取该合并引入的所有 commit 的作者
  while IFS= read -r author; do
    [ -z "$author" ] && continue
    email="${author#*<}"; email="${email%>}"
    name="${author%% <*}"
    [ "$name" = "$OWNER" ] && continue
    key="$name <$email>"
    AUTHOR_PRS["$key"]="${AUTHOR_PRS[$key]:-} #$pr_num"
    PR_TITLES["$pr_num"]=$(echo "$subject" | sed 's/^[a-f0-9]* Merge PR #[0-9]*: //')
  done < <(git log --format="%an <%ae>" "$hash"~1.."$hash" | sort -u)
done < <(git log --oneline --format="%H %s" main | grep "^[a-f0-9]* Merge PR #")

# ── 来源 2：sync 流程并入的 PR（本地 pr-N 分支） ──

for br in $(git for-each-ref --format='%(refname:short)' refs/heads/pr-* 2>/dev/null); do
  pr_num="${br#pr-}"
  # 跳过已被来源 1 覆盖的
  [ -n "${PR_TITLES[$pr_num]:-}" ] && continue
  # 提取分支上不在 main 中的 commit 作者
  while IFS= read -r author; do
    [ -z "$author" ] && continue
    email="${author#*<}"; email="${email%>}"
    name="${author%% <*}"
    [ "$name" = "$OWNER" ] && continue
    key="$name <$email>"
    AUTHOR_PRS["$key"]="${AUTHOR_PRS[$key]:-} #$pr_num"
  done < <(git log "$br" --not main --format="%an <%ae>" 2>/dev/null | sort -u)
  # 取 PR 标题（分支上第一个不在 main 中的 commit 消息）
  title=$(git log "$br" --not main --format="%s" 2>/dev/null | tail -1)
  PR_TITLES["$pr_num"]="${title:-PR #$pr_num}"
done

# ── 输出 ──

{
  echo "# Contributors ✨"
  echo ""
  echo "感谢以下贡献者（按首次贡献时间排序）："
  echo ""
  echo "| 贡献者 | 贡献 | PR |"
  echo "|--------|------|-----|"

  # 按 PR 编号排序输出（近似首次贡献时间）
  for key in $(for k in "${!AUTHOR_PRS[@]}"; do
    first_pr=$(echo "${AUTHOR_PRS[$k]}" | tr ' ' '\n' | grep -o '[0-9]*' | sort -n | head -1)
    echo "$first_pr $k"
  done | sort -n | cut -d' ' -f2-); do
    name="${key%% <*}"
    prs="${AUTHOR_PRS[$key]}"
    # 去重 + 排序 PR 编号
    pr_nums=$(echo "$prs" | tr ' ' '\n' | grep -o '[0-9]*' | sort -n | uniq)
    links=""
    descs=""
    for pr in $pr_nums; do
      links="$links [#$pr](https://github.com/huiliyi37/Tianshu-Tui/pull/$pr),"
      title="${PR_TITLES[$pr]:-}"
      # 取标题前 50 字符作为简短描述
      descs="$descs ${title:0:50}；"
    done
    links="${links%,}"
    descs="${descs%;}"
    echo "| **$name** | $descs | $links |"
  done

  echo ""
  echo "本文件由 \`scripts/update-contributors.sh\` 自动生成。运行 \`bash scripts/update-contributors.sh\` 更新。"
} > "$OUTPUT"

echo "CONTRIBUTORS.md updated with ${#AUTHOR_PRS[@]} external contributors."
