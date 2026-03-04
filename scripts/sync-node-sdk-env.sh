#!/usr/bin/env bash
set -euo pipefail

SOURCE="${1:-$HOME/code/node-sdk/.env}"
TARGET=".env"

if [[ ! -f "$SOURCE" ]]; then
  echo "Source env file not found: $SOURCE" >&2
  exit 1
fi

tmp_file="$(mktemp)"
{
  echo "# Synced from $SOURCE"
  echo "# Generated at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  grep -E '^(TRANSLOADIT_KEY|TRANSLOADIT_SECRET|TRANSLOADIT_ENDPOINT)=' "$SOURCE" || true
} > "$tmp_file"

if ! grep -q '^TRANSLOADIT_KEY=' "$tmp_file"; then
  echo "Missing TRANSLOADIT_KEY in $SOURCE" >&2
  rm -f "$tmp_file"
  exit 1
fi

if ! grep -q '^TRANSLOADIT_SECRET=' "$tmp_file"; then
  echo "Missing TRANSLOADIT_SECRET in $SOURCE" >&2
  rm -f "$tmp_file"
  exit 1
fi

mv "$tmp_file" "$TARGET"
echo "Wrote $TARGET from $SOURCE"
