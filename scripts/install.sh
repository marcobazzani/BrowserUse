#!/usr/bin/env bash
# BrowserUse installer — downloads a release and registers the MCP server
# with Claude Code (and OpenCode / GitHub Copilot CLI when present).
# Pairing is automatic: the extension and the MCP server derive the same
# token+port from your timezone + OS on each start. No copy-paste, no port
# config.
#
# Channels (single install — dev replaces stable, same dir, same MCP name):
#   stable (default) — latest non-prerelease tag, e.g. v0.10.0
#   dev              — latest GitHub prerelease tag, e.g. v0.10.0-rc.2
#                      Re-running with channel=stable later puts you back on
#                      the latest stable build.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/marcobazzani/BrowserUse/main/scripts/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/marcobazzani/BrowserUse/main/scripts/install-dev.sh | bash
#
# Or directly:
#   BROWSERUSE_CHANNEL=dev bash scripts/install.sh
#
set -euo pipefail

REPO="marcobazzani/BrowserUse"
CHANNEL="${BROWSERUSE_CHANNEL:-stable}"
case "$CHANNEL" in
  stable|dev) ;;
  *) printf '\033[1;31m×  \033[0m Unknown BROWSERUSE_CHANNEL=%s. Use stable|dev.\n' "$CHANNEL" >&2; exit 1 ;;
esac
INSTALL_DIR="${HOME}/.browseruse"
EXT_DIR="${INSTALL_DIR}/extension"
SERVER_DIR="${INSTALL_DIR}/mcp-server"
MCP_NAME="browseruse"

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

# --- Resolve target version --------------------------------------------------
if [ "$CHANNEL" = "dev" ]; then
  # Latest prerelease — uses GitHub REST API (anonymous, low rate limit but
  # one call per install is fine). Node is already a hard dep so we use it
  # to parse JSON without needing jq/python on the target machine.
  _note "Looking up latest BrowserUse PRE-RELEASE..."
  RELEASES_JSON="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases?per_page=20" 2>/dev/null || true)"
  TAG="$(printf '%s' "$RELEASES_JSON" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);const r=a.find(x=>x.prerelease&&!x.draft);process.stdout.write(r?r.tag_name:"");}catch(e){}})' \
    || true)"
  if [ -z "${TAG:-}" ]; then
    _die "Could not resolve latest prerelease. Check your network and rate limit, or set BROWSERUSE_TAG=vX.Y.Z-rc.N to override."
  fi
else
  # /releases/latest redirects to /releases/tag/vX.Y.Z (skips prereleases) —
  # no API, no auth, no rate limit.
  _note "Looking up latest BrowserUse release..."
  LATEST_URL="$(curl -fsSI "https://github.com/${REPO}/releases/latest" 2>/dev/null \
    | sed -n 's#^[Ll]ocation: *\(.*\)#\1#p' | tr -d '\r' | tail -n1)"
  TAG="$(printf '%s' "$LATEST_URL" | sed 's#.*/tag/##')"

  if [ -z "${TAG:-}" ]; then
    _die "Could not resolve latest release. Check your network and try again."
  fi
fi
# Explicit override always wins.
TAG="${BROWSERUSE_TAG:-$TAG}"

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
  _note "Registering MCP server with Claude Code (user scope) as '${MCP_NAME}'..."
  if claude mcp list 2>/dev/null | grep -q "^${MCP_NAME}"; then
    _note "Existing '${MCP_NAME}' MCP entry found — removing and re-adding."
    claude mcp remove "${MCP_NAME}" --scope user >/dev/null 2>&1 || true
  fi
  claude mcp add "${MCP_NAME}" --scope user -- node "$ENTRY"
  CLAUDE_STATUS="registered"
else
  _warn "'claude' CLI not found on PATH. Add this manually to ~/.claude/settings.json:"
  cat <<EOF

{
  "mcpServers": {
    "${MCP_NAME}": {
      "command": "node",
      "args": ["${ENTRY}"]
    }
  }
}

EOF
  CLAUDE_STATUS="manual"
fi

# --- Register with OpenCode -------------------------------------------------
OC_CFG="${HOME}/.opencode/config.json"
OPENCODE_STATUS="skip"
if command -v opencode >/dev/null 2>&1; then
  if command -v jq >/dev/null 2>&1; then
    _note "Registering MCP server with OpenCode..."
    mkdir -p "$(dirname "$OC_CFG")"
    if [ -f "$OC_CFG" ]; then
      TMP_CFG="$(mktemp)"
      jq --arg n "node" --arg e "$ENTRY" --arg k "$MCP_NAME" \
        '.mcp[$k] = {"type":"local","command":[$n,$e],"enabled":true}' \
        "$OC_CFG" > "$TMP_CFG" && mv "$TMP_CFG" "$OC_CFG"
    else
      jq -n --arg n "node" --arg e "$ENTRY" --arg k "$MCP_NAME" \
        '{"mcp":{($k):{"type":"local","command":[$n,$e],"enabled":true}}}' \
        > "$OC_CFG"
    fi
    OPENCODE_STATUS="registered"
  else
    _warn "'jq' not found — cannot auto-update OpenCode config. Add manually to ${OC_CFG}:"
    cat <<EOF

{
  "mcp": {
    "${MCP_NAME}": {
      "type": "local",
      "command": ["node", "${ENTRY}"],
      "enabled": true
    }
  }
}

EOF
    OPENCODE_STATUS="manual"
  fi
fi

# --- Register with GitHub Copilot CLI ---------------------------------------
GH_CFG="${HOME}/.copilot/mcp-config.json"
COPILOT_STATUS="skip"
if command -v copilot >/dev/null 2>&1; then
  if command -v jq >/dev/null 2>&1; then
    _note "Registering MCP server with GitHub Copilot CLI..."
    mkdir -p "$(dirname "$GH_CFG")"
    if [ -f "$GH_CFG" ]; then
      TMP_CFG="$(mktemp)"
      jq --arg n "node" --arg e "$ENTRY" --arg k "$MCP_NAME" \
        '.servers[$k] = {"type":"stdio","command":$n,"args":[$e]}' \
        "$GH_CFG" > "$TMP_CFG" && mv "$TMP_CFG" "$GH_CFG"
    else
      jq -n --arg n "node" --arg e "$ENTRY" --arg k "$MCP_NAME" \
        '{"servers":{($k):{"type":"stdio","command":$n,"args":[$e]}}}' \
        > "$GH_CFG"
    fi
    COPILOT_STATUS="registered"
  else
    _warn "'jq' not found — cannot auto-update Copilot config. Add manually to ${GH_CFG}:"
    cat <<EOF

{
  "servers": {
    "${MCP_NAME}": {
      "type": "stdio",
      "command": "node",
      "args": ["${ENTRY}"]
    }
  }
}

EOF
    COPILOT_STATUS="manual"
  fi
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
  5. Start Claude Code, OpenCode, or GitHub Copilot CLI and try:
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
if [ "$OPENCODE_STATUS" = "manual" ]; then
  _warn "You still need to add the MCP server entry to ${OC_CFG} (see above)."
fi
if [ "$COPILOT_STATUS" = "manual" ]; then
  _warn "You still need to add the MCP server entry to ${GH_CFG} (see above)."
fi
