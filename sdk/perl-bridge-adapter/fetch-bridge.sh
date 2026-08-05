#!/usr/bin/env bash
# Install the Node-based bridge that ships inside the cursor-sdk Python wheel.
# The GitHub standalone archive currently 500s on local CreateAgent; the wheel
# binary is what the first-party Python SDK uses.
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$ROOT"

VERSION="${1:-}"
SPEC="cursor-sdk"
if [ -n "$VERSION" ]; then
  SPEC="cursor-sdk==${VERSION#v}"
fi

python3 -m venv .bridge-venv
# shellcheck disable=SC1091
source .bridge-venv/bin/activate
pip install -q --upgrade pip
pip install -q "$SPEC"

BRIDGE_BIN="$(python -c 'from cursor_sdk._vendor import resolve_bridge_path; print(resolve_bridge_path())')"
BRIDGE_ROOT="$(CDPATH= cd -- "$(dirname -- "$BRIDGE_BIN")/.." && pwd)"

rm -rf cursor-sdk-bridge
ln -sfn "$BRIDGE_ROOT" cursor-sdk-bridge

echo "Bridge linked from $SPEC"
if [ -f cursor-sdk-bridge/manifest.json ]; then
  cat cursor-sdk-bridge/manifest.json
fi
echo "Executable: ./cursor-sdk-bridge/bin/cursor-sdk-bridge"
