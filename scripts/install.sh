#!/usr/bin/env bash
# BrowserUse installer — downloads the latest release, sets up a token, registers
# the MCP server with Claude Code, and tells you how to load the extension.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/marcobazzani/BrowserUse/main/scripts/install.sh | bash
#
set -euo pipefail

REPO="marcobazzani/BrowserUse"
INSTALL_DIR="${HOME}/.browseruse"
EXT_DIR="${INSTALL_DIR}/extension"
SERVER_DIR="${INSTALL_DIR}/mcp-server"
TOKEN_FILE="${INSTALL_DIR}/token"

_note()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
_warn()  { printf '\033[1;33m!! \033[0m %s\n' "$*" >&2; }
_die()   { printf '\033[1;31m×  \033[0m %s\n' "$*" >&2; exit 1; }

# --- OS detection ------------------------------------------------------------
OS="$(uname -s 2>/dev/null || echo unknown)"
case "$OS" in
  Darwin) ;;
  Linux)  ;;
  MINGW*|MSYS*|CYGWIN*) _die "Windows detected. Use WSL, or follow the manual install in the README." ;;
  *) _die "Unsupported OS: $OS. Install manually per the README." ;;
esac

# --- Dependencies ------------------------------------------------------------
for cmd in curl unzip tar node; do
  command -v "$cmd" >/dev/null 2>&1 || _die "'$cmd' is required but not installed."
done

NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  _die "Node 20+ required (found $(node -v)). Upgrade and re-run."
fi

# --- Fetch latest release metadata ------------------------------------------
_note "Looking up latest BrowserUse release on GitHub..."
META="$(curl -fsSL -H 'Accept: application/vnd.github+json' \
  "https://api.github.com/repos/${REPO}/releases/latest" \
  || _die "Could not contact GitHub. Are you online?")"

TAG="$(printf '%s' "$META" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)"
EXT_URL="$(printf '%s' "$META" | sed -n 's#.*"browser_download_url": *"\(https://[^"]*browseruse-extension-[^"]*\.zip\)".*#\1#p' | head -n1)"
SRV_URL="$(printf '%s' "$META" | sed -n 's#.*"browser_download_url": *"\(https://[^"]*browseruse-mcp-server-[^"]*\.tgz\)".*#\1#p' | head -n1)"

if [ -z "${TAG:-}" ] || [ -z "${EXT_URL:-}" ] || [ -z "${SRV_URL:-}" ]; then
  _die "No published release found yet. Push a tag 'vX.Y.Z' to trigger the release workflow, then re-run the installer."
fi

_note "Installing ${REPO} ${TAG}"

# --- Download + unpack -------------------------------------------------------
TMP="$(mktemp -d -t browseruse-install.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

_note "Downloading extension..."
curl -fsSL -o "${TMP}/extension.zip" "$EXT_URL"
_note "Downloading MCP server..."
curl -fsSL -o "${TMP}/mcp-server.tgz" "$SRV_URL"

mkdir -p "$INSTALL_DIR"

_note "Unpacking extension to ${EXT_DIR}"
rm -rf "$EXT_DIR"
mkdir -p "$EXT_DIR"
unzip -q "${TMP}/extension.zip" -d "$EXT_DIR"

_note "Unpacking MCP server to ${SERVER_DIR}"
rm -rf "$SERVER_DIR"
mkdir -p "$SERVER_DIR"
tar -xzf "${TMP}/mcp-server.tgz" -C "$SERVER_DIR"

# --- Token -------------------------------------------------------------------
if [ -f "$TOKEN_FILE" ] && [ "${BROWSERUSE_REINIT:-0}" != "1" ]; then
  _note "Keeping existing auth token at $TOKEN_FILE (set BROWSERUSE_REINIT=1 to regenerate)."
  TOKEN="$(cat "$TOKEN_FILE")"
else
  _note "Generating a new auth token at $TOKEN_FILE"
  if command -v openssl >/dev/null 2>&1; then
    TOKEN="$(openssl rand -hex 24)"
  else
    TOKEN="$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')"
  fi
  umask 077
  printf '%s' "$TOKEN" > "$TOKEN_FILE"
fi
chmod 600 "$TOKEN_FILE"

# --- Register with Claude Code ----------------------------------------------
ENTRY="${SERVER_DIR}/dist/index.cjs"
if [ ! -f "$ENTRY" ]; then
  _die "MCP server entrypoint not found at $ENTRY — release archive layout may have changed."
fi

if command -v claude >/dev/null 2>&1; then
  _note "Registering MCP server with Claude Code (user scope)..."
  if claude mcp list 2>/dev/null | grep -q '^browseruse'; then
    _note "Existing 'browseruse' MCP entry found — removing so we can re-add with the current token."
    claude mcp remove browseruse --scope user >/dev/null 2>&1 || true
  fi
  claude mcp add browseruse --scope user \
    --env "BROWSERUSE_TOKEN=${TOKEN}" \
    -- node "$ENTRY"
  CLAUDE_STATUS="registered"
else
  _warn "'claude' CLI not found on PATH. Add this manually to ~/.claude/settings.json:"
  cat <<EOF

{
  "mcpServers": {
    "browseruse": {
      "command": "node",
      "args": ["${ENTRY}"],
      "env": { "BROWSERUSE_TOKEN": "${TOKEN}" }
    }
  }
}

EOF
  CLAUDE_STATUS="manual"
fi

# --- Final instructions ------------------------------------------------------
cat <<EOF

------------------------------------------------------------------
  BrowserUse ${TAG} installed.
------------------------------------------------------------------

  Extension:   ${EXT_DIR}
  MCP server:  ${ENTRY}
  Auth token:  ${TOKEN_FILE}   (mode 0600)

  Next steps:

  1. Open chrome://extensions
  2. Enable "Developer mode" (top-right toggle)
  3. Click "Load unpacked" and select:
       ${EXT_DIR}
  4. Pin the BrowserUse toolbar icon (puzzle-piece menu → pin)
  5. Click the icon, paste this token, Save:

       ${TOKEN}

  6. Start Claude Code and try:
       "open https://example.com in a new tab and tell me the title"

EOF

if [ "$CLAUDE_STATUS" = "manual" ]; then
  _warn "You still need to add the MCP server entry to ~/.claude/settings.json (see above)."
fi
