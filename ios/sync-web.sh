#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/dist"
dst="$root/ios/Web"

if [ ! -f "$src/index.html" ]; then
  echo "error: $src/index.html is missing — run 'pnpm build' first" >&2
  exit 1
fi

rm -rf "$dst"
mkdir -p "$dst"
cp -R "$src"/. "$dst"/

echo "synced $(find "$dst" -type f | wc -l | tr -d ' ') files into ios/Web"
