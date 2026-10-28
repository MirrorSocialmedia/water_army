#!/usr/bin/env bash
# release-status-provenance.sh — 生成/校驗 docs/release-status.md §1 測試數字（WA-RELEASE-STATUS B）
# 用法:
#   bash scripts/release-status-provenance.sh            # 實跑 npm test（全套+分層），輸出可貼入 release-status.md 的金額欄
#   bash scripts/release-status-provenance.sh --check    # 同上 + 比對 docs/release-status.md §1 數字；不一致 exit 1（未填 placeholder = exit 2）
# 計法 = repo package.json scripts（npm test = unit+integration hermetic 全套）。
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

MODE="print"; [ "${1:-}" = "--check" ] && MODE="check"

sum_one() { # $1=label $2...=cmd — 跑命令、抓 node --test 匯總（spec reporter 嘅 ℹ 行，輸出可能落 stderr）
  local label="$1"; shift
  local out; out="$("$@" 2>&1)"
  local tests pass fail skipped
  tests=$(printf '%s\n' "$out" | sed -n 's/^.*ℹ[[:space:]]*tests[[:space:]]\{1,\}\([0-9]\{1,\}\).*/\1/p;s/^# tests[[:space:]]\{1,\}\([0-9]\{1,\}\).*/\1/p' | tail -1)
  pass=$(printf '%s\n' "$out" | sed -n 's/^.*ℹ[[:space:]]*pass[[:space:]]\{1,\}\([0-9]\{1,\}\).*/\1/p;s/^# pass[[:space:]]\{1,\}\([0-9]\{1,\}\).*/\1/p' | tail -1)
  fail=$(printf '%s\n' "$out" | sed -n 's/^.*ℹ[[:space:]]*fail[[:space:]]\{1,\}\([0-9]\{1,\}\).*/\1/p;s/^# fail[[:space:]]\{1,\}\([0-9]\{1,\}\).*/\1/p' | tail -1)
  skipped=$(printf '%s\n' "$out" | sed -n 's/^.*ℹ[[:space:]]*skipped[[:space:]]\{1,\}\([0-9]\{1,\}\).*/\1/p;s/^# skipped[[:space:]]\{1,\}\([0-9]\{1,\}\).*/\1/p' | tail -1)
  if [ -z "${tests:-}" ] || [ -z "${pass:-}" ] || [ -z "${fail:-}" ]; then
    echo "ERROR: 無法由命令輸出解析 node --test 匯總（label=$label）" >&2
    printf '%s\n' "$out" | tail -20 >&2
    return 3
  fi
  echo "$label: total=$tests pass=$pass fail=$fail skip=${skipped:-0}"
}

SHA=$(git rev-parse HEAD)
if [ -z "$(git status --porcelain)" ]; then TREE=clean; else TREE=dirty; fi

echo "# release-status provenance"
echo "date: $(date -Iseconds)"
echo "commit: $SHA"
echo "tree: $TREE"
sum_one "suite" npm test --silent || exit 3
sum_one "unit" npm run test:unit --silent || exit 3
sum_one "integration" npm run test:integration --silent || exit 3

if [ "$MODE" = "check" ]; then
  DOC=docs/release-status.md
  [ -f "$DOC" ] || { echo "FAIL: $DOC 不存在" >&2; exit 1; }
  if grep -q '__TOTAL__\|__PASSN__\|__FAILN__\|__SKIPN__\|__UNIT_N__\|__INT_N__' "$DOC"; then
    echo "CHECK: $DOC §1 仍有 placeholder（未填數）" >&2; exit 2
  fi
  # 由文檔 §1 表抽取：行含 「npm test` | N | A pass / B fail / C skip」；unit/integration 行含 「N」 pass 數
  read -r d_total d_pass d_fail d_skip < <(grep 'npm test`' "$DOC" | head -1 | sed -E 's/.*\| *([0-9]+) *\| *([0-9]+) pass \/ *([0-9]+) fail \/ *([0-9]+) skip.*/\1 \2 \3 \4/')
  # 重新解析實跑數字做比對
  actual=$( { sum_one "suite" npm test --silent; } | head -1 )
  a_total=$(printf '%s' "$actual" | sed -E 's/.*total=([0-9]+).*/\1/'); a_pass=$(printf '%s' "$actual" | sed -E 's/.*pass=([0-9]+).*/\1/')
  a_fail=$(printf '%s' "$actual" | sed -E 's/.*fail=([0-9]+).*/\1/');  a_skip=$(printf '%s' "$actual" | sed -E 's/.*skip=([0-9]+).*/\1/')
  if [ "${d_total:-}" = "$a_total" ] && [ "${d_pass:-}" = "$a_pass" ] && [ "${d_fail:-}" = "$a_fail" ] && [ "${d_skip:-}" = "$a_skip" ]; then
    echo "CHECK OK: $DOC §1 = 實跑（total=$a_total pass=$a_pass fail=$a_fail skip=$a_skip）"
  else
    echo "CHECK FAIL: 文檔=total=$d_total pass=$d_pass fail=$d_fail skip=$d_skip vs 實跑=total=$a_total pass=$a_pass fail=$a_fail skip=$a_skip" >&2
    exit 1
  fi
fi
