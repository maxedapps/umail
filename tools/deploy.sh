#!/usr/bin/env bash
# `pnpm deploy:stage`: deploys a uMail stage with the vault of the stage Alchemy targets (adrs/0012):
# `prod` for the prod stage, `dev` for every other. As Alchemy does, `--stage` wins over $ALCHEMY_STAGE.
set -euo pipefail

stage=${ALCHEMY_STAGE-}
for ((i = 1; i <= $#; i++)); do
  case ${!i} in
    --stage=*) stage=${!i#--stage=} ;;
    --stage) next=$((i + 1)) && stage=${!next-} ;;
  esac
done

vault=dev
if [[ $stage == prod ]]; then vault=prod; fi
exec agents run --env "$vault" -- agents heavy -- alchemy deploy "$@"
