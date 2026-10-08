#!/bin/sh
set -eu

# Pin both the executable and its digest; a failed bootstrap must never fall
# back to installing dependencies without Safe Chain.
version=1.5.24
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)
    platform=macos-arm64
    digest=638932561b1e5e93affbe442567c4144795d0993a83022df02d7833495279f5a
    ;;
  Darwin-x86_64)
    platform=macos-x64
    digest=6f7c770207bf518f1cabc4ad550a6bf12fb5c746fec468eddc854074ac381e8f
    ;;
  Linux-aarch64|Linux-arm64)
    platform=linuxstatic-arm64
    digest=4330cf61abf0f15ae2bbb1d0acad2c27c1dd4a0e036502ba60fb77c535ec8f0b
    ;;
  Linux-x86_64)
    platform=linuxstatic-x64
    digest=0fab32652c8de7c1a5bec66cbb729d4e813df0d46d78afb2c2ac664c731756a3
    ;;
  *)
    echo "Safe Chain bootstrap supports macOS and Linux on x64/arm64." >&2
    exit 1
    ;;
esac

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
binary_dir="$repo_root/.context/safe-chain/$version/$platform"
binary="$binary_dir/safe-chain"
mkdir -p "$binary_dir"

if [ ! -f "$binary" ]; then
  download=$(mktemp "$binary_dir/download.XXXXXX")
  trap 'rm -f "$download"' EXIT HUP INT TERM
  curl -fsSL "https://github.com/AikidoSec/safe-chain/releases/download/$version/safe-chain-$platform" -o "$download"
else
  download="$binary"
fi

if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$download")
else
  actual=$(shasum -a 256 "$download")
fi
if [ "${actual%% *}" != "$digest" ]; then
  echo "Safe Chain checksum verification failed; refusing to run pnpm." >&2
  exit 1
fi

if [ "$download" != "$binary" ]; then
  mv "$download" "$binary"
fi
chmod +x "$binary"
exec "$binary" pnpm "$@"
