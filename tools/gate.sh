#!/usr/bin/env bash
# The landing gate (adrs/0007-adaptive-gate.md): the fast checks run whole; Vitest's --changed runs
# only the slow specs the change against main reaches. `--list` prints that selection and runs nothing.
set -euo pipefail

root=$PWD
report=$(mktemp --suffix=.json)
trap 'rm -f "$report"' EXIT

run() {
  printf '\n$ %s\n' "$*"
  "$@"
}

# A Vitest suite by its config. When it fails, each failing test reruns alone once
# (tools/rerun-alone.ts) and the gate stays red.
suite() {
  if [[ $list ]]; then
    run vitest list --filesOnly --config "$@"
  elif ! run vitest run --config "$@" --reporter=default --reporter=json --outputFile.json="$report"; then
    node "$root/tools/rerun-alone.ts" "$1" "$report"
    exit 1
  fi
}

if [[ "${1-}" == --list ]]; then
  list=1
else
  list=
  run oxfmt --check .
  run pnpm lint
  run pnpm typecheck
  suite vitest.config.ts
fi

suite vitest.worker.config.ts --changed main
run cd apps/server
suite vitest.worker.config.ts --changed main
if [[ ! $list ]]; then
  # The browser suite needs the Chromium build of the pinned Playwright; once it is there this is a no-op.
  run playwright install --only-shell chromium
fi
suite vitest.browser.config.ts --changed main
