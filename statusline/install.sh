#!/bin/sh
# Installs token-meter: the /token-meter command and the statusLine entry in settings.json.
# A status line that is already set is kept in ~/.claude/token-meter/previous-statusline.json;
# uninstall.sh puts it back. Exits 3 when the user keeps their own status line;
# TOKEN_METER_REPLACE=1 replaces it without the question (for a run without a terminal, as from Claude).
set -eu

DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$DIR/.." && pwd)
CONFIG_DIR=${CLAUDE_CONFIG_DIR:-$HOME/.claude}

node_hint() {
  if command -v brew >/dev/null 2>&1; then
    echo "Install it with: brew install node" >&2
  else
    echo "Install it from https://nodejs.org, or with nvm: nvm install --lts" >&2
  fi
  echo "Then run this install again." >&2
}
if ! command -v node >/dev/null 2>&1; then
  echo "token-meter needs Node 18 or later, and node is not on PATH." >&2
  node_hint
  exit 1
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)'; then
  echo "token-meter needs Node 18 or later, found $(node --version)." >&2
  node_hint
  exit 1
fi
# The full path: the desktop app starts the status line without the PATH of your shell.
NODE=$(command -v node)

# Prints the current status line command when it is not ours, else nothing.
OTHER=$(node -e '
  const fs = require("fs")
  let settings = {}
  try { settings = JSON.parse(fs.readFileSync(process.argv[1], "utf8")) } catch {}
  const line = settings.statusLine
  if (line && !/statusline\.(mjs|ts)\b/.test(String(line.command ?? ""))) console.log(line.command ?? JSON.stringify(line))
' "$CONFIG_DIR/settings.json")

if [ -n "$OTHER" ] && [ "${TOKEN_METER_REPLACE:-}" != 1 ]; then
  echo "You already have a status line:"
  echo "  $OTHER"
  printf "Replace it with token-meter? uninstall.sh puts it back. [y/N] "
  # Under `curl … | sh` stdin is the script itself, so the answer comes from the terminal.
  if [ -t 0 ]; then
    read -r answer || answer=""
  else
    { read -r answer </dev/tty; } 2>/dev/null || answer=""
  fi
  case "$answer" in
    y | Y | yes) ;;
    *)
      echo "Nothing changed. To replace it without the question, run with TOKEN_METER_REPLACE=1."
      exit 3
      ;;
  esac
fi

mkdir -p "$CONFIG_DIR/commands" "$CONFIG_DIR/token-meter"
sed "s#TOKEN_METER#$ROOT#g" "$DIR/token-meter.md" > "$CONFIG_DIR/commands/token-meter.md"

node -e '
  const fs = require("fs")
  const [path, backup, node, script] = process.argv.slice(1)
  let settings = {}
  try { settings = JSON.parse(fs.readFileSync(path, "utf8")) } catch (error) {
    if (error.code !== "ENOENT") { console.error(`Cannot read ${path}: ${error.message}`); process.exit(1) }
  }
  const before = settings.statusLine
  if (before && !/statusline\.(mjs|ts)\b/.test(String(before.command ?? "")) && !fs.existsSync(backup)) {
    fs.writeFileSync(backup, JSON.stringify(before, null, 2) + "\n")
  }
  settings.statusLine = { type: "command", command: `"${node}" "${script}"` }
  fs.writeFileSync(path, JSON.stringify(settings, null, 2) + "\n")
' "$CONFIG_DIR/settings.json" "$CONFIG_DIR/token-meter/previous-statusline.json" "$NODE" "$DIR/statusline.mjs"

echo "Installed. The row shows on the next refresh; /token-meter config changes the settings, /token-meter update updates."
