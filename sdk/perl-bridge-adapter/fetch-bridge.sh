#!/usr/bin/env bash
# Download and unpack the standalone cursor-sdk-bridge archive for this
# machine into ./cursor-sdk-bridge/.
set -euo pipefail

VERSION="${1:-}"

case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin) OS=darwin ;;
  MINGW* | MSYS* | CYGWIN*) OS=win32 ;;
  *)
    echo "unsupported OS: $(uname -s)" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) ARCH=x64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *)
    echo "unsupported arch: $(uname -m)" >&2
    exit 1
    ;;
esac

ASSET="cursor-sdk-bridge-standalone-${OS}-${ARCH}.tar.gz"
if [ -z "$VERSION" ]; then
  URL="https://github.com/cursor/sdk-bridge/releases/latest/download/${ASSET}"
else
  URL="https://github.com/cursor/sdk-bridge/releases/download/v${VERSION#v}/${ASSET}"
fi

echo "Downloading ${URL}"
if ! curl -fSL -o "$ASSET" "$URL"; then
  if command -v gh > /dev/null 2>&1; then
    echo "curl download failed; retrying with gh" >&2
    gh release download ${VERSION:+"v${VERSION#v}"} \
      --repo cursor/sdk-bridge --pattern "$ASSET" --output "$ASSET" --clobber
  else
    echo "download failed; install gh if the repository requires auth/SSO" >&2
    exit 1
  fi
fi

rm -rf cursor-sdk-bridge
mkdir cursor-sdk-bridge
tar -xzf "$ASSET" -C cursor-sdk-bridge
rm "$ASSET"

echo "Bridge unpacked. Manifest:"
cat cursor-sdk-bridge/manifest.json
echo "Executable: ./cursor-sdk-bridge/bin/cursor-sdk-bridge"
