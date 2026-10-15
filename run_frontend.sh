#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/hr-dashboard"
if [ -x "$HOME/.nvm/versions/node/v24.16.0/bin/node" ]; then
  export PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH"
fi
exec npm run dev
