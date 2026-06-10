#!/usr/bin/env bash
# Read-only worktree hygiene report. Lists task worktrees and classifies each
# so stale leftovers get pruned deliberately instead of accumulating across
# parallel sessions. Never removes anything; it only prints status plus the
# exact cleanup command for the ones that are safe to remove.
#
# Classification (after `git fetch origin --prune`, unless --no-fetch):
#   STALE   branch tip is fully contained in origin/main (0 commits ahead)
#           AND the working tree is clean -> safe to prune.
#   DIRTY   0 commits ahead but the working tree has uncommitted changes
#           -> in-progress; do NOT prune.
#   ACTIVE  has commits not yet in origin/main -> unmerged work; leave alone.
#
# Note on squash merges: a squash-merged branch that still carries its own
# commits shows as ACTIVE here (its commits are not ancestors of origin/main).
# This reporter is deliberately conservative and only marks a worktree STALE
# when nothing would be lost.
#
# Usage: npm run worktrees:report   (or  bash scripts/list-merged-worktrees.sh)
#   --no-fetch   skip `git fetch origin --prune`
#
# Exit codes:
#   0  report printed (regardless of how many stale worktrees were found)
#   20 not inside a git repository / git failure

set -euo pipefail

FETCH=1
for arg in "$@"; do
  case "$arg" in
    --no-fetch) FETCH=0 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "list-merged-worktrees: unknown argument: $arg" >&2; exit 64 ;;
  esac
done

git rev-parse --show-toplevel >/dev/null 2>&1 || { echo "list-merged-worktrees: not inside a git repository" >&2; exit 20; }

if [ "$FETCH" = "1" ]; then
  git fetch origin --prune --quiet 2>/dev/null || { echo "list-merged-worktrees: git fetch origin failed" >&2; exit 20; }
fi

git show-ref --verify --quiet refs/remotes/origin/main || { echo "list-merged-worktrees: no refs/remotes/origin/main to compare against" >&2; exit 20; }

stale_count=0
active_count=0
dirty_count=0

# Walk worktrees via porcelain output (NUL-free, stable field order).
WT_PATH=""
WT_HEAD=""
WT_BRANCH=""
WT_IS_PRIMARY=0
WT_PRUNABLE=0

flush() {
  [ -n "$WT_PATH" ] || return 0
  # Skip the primary checkout (its .git is a real directory).
  if [ "$WT_IS_PRIMARY" = "1" ]; then return 0; fi
  # Skip entries git already considers prunable (working dir gone); a plain
  # `git worktree prune` clears these, no cleanup command needed.
  if [ "$WT_PRUNABLE" = "1" ]; then return 0; fi

  local branch_label="${WT_BRANCH:-(detached)}"
  local ahead
  ahead=$(git rev-list --count refs/remotes/origin/main.."$WT_HEAD" 2>/dev/null || echo "?")

  if [ "$ahead" != "0" ]; then
    active_count=$((active_count + 1))
    printf '  [ACTIVE] %-34s %s — %s\n' "$branch_label" "$WT_PATH" "$ahead commit(s) not in origin/main; leave alone"
  elif [ -n "$(git -C "$WT_PATH" status --porcelain=v1 2>/dev/null)" ]; then
    dirty_count=$((dirty_count + 1))
    printf '  [DIRTY]  %-34s %s — uncommitted changes; in-progress, do NOT prune\n' "$branch_label" "$WT_PATH"
  else
    stale_count=$((stale_count + 1))
    printf '  [STALE]  %-34s %s\n' "$branch_label" "$WT_PATH"
    printf '             prune with: npm run cleanup:worktree -- %s %s\n' "$WT_PATH" "$WT_BRANCH"
  fi
}

echo "Worktree hygiene report (compared against origin/main):"

while IFS= read -r line; do
  case "$line" in
    "worktree "*)
      flush
      WT_PATH="${line#worktree }"
      WT_HEAD=""
      WT_BRANCH=""
      WT_IS_PRIMARY=0
      WT_PRUNABLE=0
      [ -d "$WT_PATH/.git" ] && WT_IS_PRIMARY=1
      ;;
    "HEAD "*) WT_HEAD="${line#HEAD }" ;;
    "branch refs/heads/"*) WT_BRANCH="${line#branch refs/heads/}" ;;
    "detached") WT_BRANCH="" ;;
    "prunable"*) WT_PRUNABLE=1 ;;
  esac
done < <(git worktree list --porcelain)
flush

echo "---"
printf 'Summary: %d stale (safe to prune), %d dirty (in-progress), %d active (unmerged).\n' \
  "$stale_count" "$dirty_count" "$active_count"
if [ "$stale_count" -gt 0 ]; then
  echo "Prune stale worktrees deliberately with the per-line cleanup command above."
fi
exit 0
