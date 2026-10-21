#!/usr/bin/env bash
# Clean-clone setup for KasGate (Testnet-10 only). Run from the repo root:  ./scripts/bootstrap.sh
# 1. clones upstream kaspa-x402 next to this repo at the pinned commit and builds its packages
#    (package.json uses file:../upstream-x402/... because @kaspa-x402/* are not on npm)
# 2. downloads the rusty-kaspa WASM SDK (nodejs build) to ../vendor/kaspa-wasm32-sdk and checks its sha256
#    (only needed for the real-TN10 code and its tests; set SKIP_SDK=1 to skip)
# 3. npm ci (builds better-sqlite3)
set -euo pipefail
UPSTREAM_REPO="${UPSTREAM_REPO:-https://github.com/elldeeone/kaspa-x402}"
UPSTREAM_COMMIT="${UPSTREAM_COMMIT:-8d575de113c9cbe07ea45c9eb94514fe3307c801}"   # kaspa-x402 1.0.1 tested with KasGate
SDK_URL="${SDK_URL:-https://github.com/kaspanet/rusty-kaspa/releases/download/v2.0.0/kaspa-wasm32-sdk-v2.0.0.zip}"
SDK_SHA256="${SDK_SHA256:-eeb201e27feba98fe069f09ffefdd0032ed4f69a3f299793e64b9db9dda7df7f}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; PARENT="$(dirname "$ROOT")"

if [ ! -d "$PARENT/upstream-x402/.git" ]; then git clone "$UPSTREAM_REPO" "$PARENT/upstream-x402"; fi
git -C "$PARENT/upstream-x402" fetch -q origin "$UPSTREAM_COMMIT" 2>/dev/null || true
git -C "$PARENT/upstream-x402" checkout -q "$UPSTREAM_COMMIT"
(cd "$PARENT/upstream-x402/protocol" && npm ci && npm run build)

if [ "${SKIP_SDK:-0}" != "1" ] && [ ! -d "$PARENT/vendor/kaspa-wasm32-sdk/nodejs/kaspa" ]; then
  mkdir -p "$PARENT/vendor"; curl -fsSL -o "$PARENT/vendor/sdk.zip" "$SDK_URL"
  echo "$SDK_SHA256  $PARENT/vendor/sdk.zip" | sha256sum -c -
  (cd "$PARENT/vendor" && unzip -q -o sdk.zip)
  [ -d "$PARENT/vendor/kaspa-wasm32-sdk/nodejs/kaspa" ] || { echo "SDK layout unexpected; set KASPA_WASM_SDK to the nodejs/kaspa folder" >&2; exit 1; }
fi

cd "$ROOT" && npm ci
echo "ok. Run: npm test   (real-chain tests skip with a reason if the WASM SDK is missing)"
