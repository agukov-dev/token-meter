#!/bin/sh
# Installs or updates token-meter:
#   curl -fsSL https://raw.githubusercontent.com/agukov-dev/token-meter/main/install.sh | sh
# Downloads the code to ~/.claude/token-meter/app and runs statusline/install.sh from it.
# The settings and the spend history in ~/.claude/token-meter stay.
set -eu

CONFIG_DIR=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
APP=$CONFIG_DIR/token-meter/app
URL=${TOKEN_METER_URL:-https://codeload.github.com/agukov-dev/token-meter/tar.gz/refs/heads/main}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "Downloading token-meter…"
curl -fsSL "$URL" | tar -xz -C "$TMP"
SRC=$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -n 1)
[ -f "$SRC/statusline/statusline.mjs" ] || { echo "The download has no statusline/statusline.mjs." >&2; exit 1; }

IS_UPDATE=false
[ -d "$APP" ] && IS_UPDATE=true
mkdir -p "$CONFIG_DIR/token-meter"
rm -rf "$APP"
mv "$SRC" "$APP"

status=0
sh "$APP/statusline/install.sh" || status=$?
if [ "$status" -ne 0 ]; then
  # A first install that was declined or failed leaves nothing behind.
  $IS_UPDATE || { rm -rf "$APP"; rmdir "$CONFIG_DIR/token-meter" 2>/dev/null || true; }
  exit "$status"
fi
if $IS_UPDATE; then echo "Updated."; fi
