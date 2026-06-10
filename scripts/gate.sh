#!/usr/bin/env bash
# Single pre-PR gate: run the three required checks (tests, typecheck,
# package dry-run) with one combined, quiet-on-success output instead of
# three separate verbose command blocks.
#
# On success: one summary line. On the first failure: the failing step's
# captured output is printed and the gate stops with that step's exit code.
#
# Usage: npm run gate   (or  bash scripts/gate.sh)
#   -v / --verbose   stream each step's output live instead of buffering
#
# Steps mirror AGENTS.md "Per-task steps": npm test, npm run check,
# npm run pack:dry-run.

set -uo pipefail

VERBOSE=0
for arg in "$@"; do
  case "$arg" in
    -v|--verbose) VERBOSE=1 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "gate: unknown argument: $arg" >&2; exit 64 ;;
  esac
done

REPO_TOP=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$REPO_TOP"

run_step() {
  local label="$1"; shift
  if [ "$VERBOSE" = "1" ]; then
    printf 'gate: %s...\n' "$label" >&2
    "$@"
    return $?
  fi
  local out code lines
  out=$(mktemp)
  # Capture the step's exit code IMMEDIATELY. Do not test it inside an `if`
  # compound first: a failed `if` condition with no `else` yields $? == 0,
  # which would mask the real failure and let the gate report PASS.
  "$@" >"$out" 2>&1
  code=$?
  if [ "$code" -eq 0 ]; then
    rm -f "$out"
    return 0
  fi
  lines=$(wc -l <"$out" | tr -d ' ')
  printf 'gate: %s FAILED (exit %d)\n' "$label" "$code" >&2
  if [ "$lines" -gt 200 ]; then
    tail -n 200 "$out" >&2
    printf 'gate: (showed last 200 of %s lines; full log: %s)\n' "$lines" "$out" >&2
  else
    cat "$out" >&2
    rm -f "$out"
  fi
  return "$code"
}

run_step "test (npm test)"            npm test            || exit $?
run_step "check (npm run check)"      npm run check       || exit $?
run_step "pack (npm run pack:dry-run)" npm run pack:dry-run || exit $?

printf 'gate: PASS — test OK, check OK, pack:dry-run OK\n'
exit 0
