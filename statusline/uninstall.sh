#!/bin/sh
# Removes token-meter: the /token-meter command, the statusLine entry and the data in ~/.claude/token-meter.
# A status line that install.sh replaced is put back.
set -eu

CONFIG_DIR=${CLAUDE_CONFIG_DIR:-$HOME/.claude}

node -e '
  const fs = require("fs")
  const [path, backup] = process.argv.slice(1)
  let settings
  try { settings = JSON.parse(fs.readFileSync(path, "utf8")) } catch { process.exit(0) }
  if (!/statusline\.(mjs|ts)\b/.test(String(settings.statusLine?.command ?? ""))) process.exit(0)
  if (fs.existsSync(backup)) {
    settings.statusLine = JSON.parse(fs.readFileSync(backup, "utf8"))
    console.log(`Restored your status line: ${settings.statusLine.command ?? ""}`)
  } else {
    delete settings.statusLine
  }
  fs.writeFileSync(path, JSON.stringify(settings, null, 2) + "\n")
' "$CONFIG_DIR/settings.json" "$CONFIG_DIR/token-meter/previous-statusline.json"

ROOT=$(cd "$(dirname "$0")/.." && pwd)
rm -f "$CONFIG_DIR/commands/token-meter.md"
rm -rf "$CONFIG_DIR/token-meter"
echo "Removed token-meter."
# An install from a clone runs the code from the clone; it is the user's to delete.
case "$ROOT" in
  "$CONFIG_DIR/token-meter/"*) ;;
  *) echo "The clone in $ROOT stays; delete it by hand." ;;
esac
