#!/usr/bin/env bash
# PolyBot macOS pack — same role as craft-agents-oss `scripts/build-dmg.sh`, without
# Craft-only vendors (Codex/Bun SDK/S3). Run from any cwd.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON_DIR="$(dirname "$SCRIPT_DIR")"
ROOT_DIR="$(dirname "$(dirname "$ELECTRON_DIR")")"

require_path() {
  if [[ ! -e "$1" ]]; then
    echo "ERROR: $2 — expected at $1"
    [[ -n "${3:-}" ]] && echo "$3"
    exit 1
  fi
}

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ROOT_DIR/.env"
  set +a
  echo "Loaded $ROOT_DIR/.env"
fi

echo "=== PolyBot macOS (electron-builder) ==="
cd "$ROOT_DIR"
bun install
bun run electron:build

require_path "$ROOT_DIR/node_modules/electron/dist/Electron.app" \
  "Electron macOS distributable" \
  "Run: bun install (postinstall must unpack electron)."

cd "$ELECTRON_DIR"
exec bun x electron-builder --config electron-builder.mac.yml --mac "$@"
