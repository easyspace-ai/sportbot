#!/usr/bin/env bash
# PolyBot Linux AppImage — craft-style wrapper; no Craft-specific vendors.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON_DIR="$(dirname "$SCRIPT_DIR")"
ROOT_DIR="$(dirname "$(dirname "$ELECTRON_DIR")")"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ROOT_DIR/.env"
  set +a
  echo "Loaded $ROOT_DIR/.env"
fi

echo "=== PolyBot Linux (electron-builder) ==="
cd "$ROOT_DIR"
bun install
bun run electron:build

cd "$ELECTRON_DIR"
exec bun x electron-builder --config electron-builder.yml --linux "$@"
