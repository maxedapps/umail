#!/usr/bin/env bash
# The landing gate (adrs/0007-adaptive-gate.md): the fast checks run whole; Vitest's --changed runs
# only the slow specs the change against main reaches. `--list` prints that selection and runs nothing.
set -euo pipefail

run() {
  printf '\n$ %s\n' "$*"
  "$@"
}

if [[ "${1-}" == --list ]]; then
  mode=(list --filesOnly)
else
  mode=(run)
  run oxfmt --check .
  run pnpm lint
  run pnpm typecheck
  run vitest run
fi

run vitest "${mode[@]}" --config vitest.worker.config.ts --changed main
run cd apps/server
run vitest "${mode[@]}" --config vitest.worker.config.ts --changed main
run vitest "${mode[@]}" --config vitest.browser.config.ts --changed main
