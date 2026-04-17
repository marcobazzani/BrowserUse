#!/usr/bin/env bash
# BrowserUse installer — downloads the latest release and registers the MCP
# server with Claude Code. Pairing is automatic: the extension and the MCP
# server derive the same token+port from your timezone + OS on each start.
# No copy-paste, no port config.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/marcobazzani/BrowserUse/main/scripts/install.sh | bash
#
set -euo pipefail

REPO="marcobazzani/BrowserUse"
INSTALL_DIR="${HOME}/.browseruse"
EXT_DIR="${INSTALL_DIR}/extension"
SERVER_DIR="${INSTALL_DIR}/mcp-server"

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

# --- Resolve latest version --------------------------------------------------
# /releases/latest redirects to /releases/tag/vX.Y.Z — no API, no auth, no rate limit.
_note "Looking up latest BrowserUse release..."
LATEST_URL="$(curl -fsSI "https://github.com/${REPO}/releases/latest" 2>/dev/null \
  | sed -n 's#^[Ll]ocation: *\(.*\)#\1#p' | tr -d '\r' | tail -n1)"
TAG="$(printf '%s' "$LATEST_URL" | sed 's#.*/tag/##')"

if [ -z "${TAG:-}" ]; then
  _die "Could not resolve latest release. Check your network and try again."
fi

EXT_URL="https://github.com/${REPO}/releases/download/${TAG}/browseruse-extension-${TAG}.zip"
SRV_URL="https://github.com/${REPO}/releases/download/${TAG}/browseruse-mcp-server-${TAG}.tgz"

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

# --- Register with Claude Code ----------------------------------------------
ENTRY="${SERVER_DIR}/dist/index.cjs"
if [ ! -f "$ENTRY" ]; then
  _die "MCP server entrypoint not found at $ENTRY — release archive layout may have changed."
fi

if command -v claude >/dev/null 2>&1; then
  _note "Registering MCP server with Claude Code (user scope)..."
  if claude mcp list 2>/dev/null | grep -q '^browseruse'; then
    _note "Existing 'browseruse' MCP entry found — removing and re-adding."
    claude mcp remove browseruse --scope user >/dev/null 2>&1 || true
  fi
  claude mcp add browseruse --scope user -- node "$ENTRY"
  CLAUDE_STATUS="registered"
else
  _warn "'claude' CLI not found on PATH. Add this manually to ~/.claude/settings.json:"
  cat <<EOF

{
  "mcpServers": {
    "browseruse": {
      "command": "node",
      "args": ["${ENTRY}"]
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

  Next steps:

  1. Open chrome://extensions
  2. Enable "Developer mode" (top-right toggle)
  3. Click "Load unpacked" and select:
       ${EXT_DIR}
  4. Pin the BrowserUse toolbar icon (puzzle-piece menu → pin)
  5. Start Claude Code and try:
       "open https://example.com in a new tab and tell me the title"

  Pairing is automatic — the extension and MCP server derive a matching
  token and port from your timezone + OS. No paste needed. If you ever
  need to override (port conflict, multi-user workstation), set
  BROWSERUSE_TOKEN / BROWSERUSE_PORT on the server and paste matching
  values in the extension popup's advanced section.

EOF

if [ "$CLAUDE_STATUS" = "manual" ]; then
  _warn "You still need to add the MCP server entry to ~/.claude/settings.json (see above)."
fi
