#!/usr/bin/env bash
set -euo pipefail
INSTALL_DIR="${HOME}/.chromanche"
LEGACY_DIR="${HOME}/.browseruse"
NAMES=("chromanche" "browseruse")
REPO="marcobazzani/Chromanche"
REF="${CHROMANCHE_REF:-main}"

CLAUDE_CFG="${HOME}/.claude/settings.json"
XDG_CFG_HOME="${XDG_CONFIG_HOME:-${HOME}/.config}"
OPENCODE_CFG="${XDG_CFG_HOME}/opencode/opencode.json"
OPENCODE_LEGACY_CFG="${HOME}/.opencode/config.json"
COPILOT_CFG="${HOME}/.copilot/mcp-config.json"
CODEX_CFG="${HOME}/.codex/config.toml"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
TMP=""
cleanup_tmp() {
  if [ -n "$TMP" ]; then
    rm -rf "$TMP"
  fi
}
trap cleanup_tmp EXIT

MCP_CONFIG_TOOL="${HERE}/lib/mcp-config.mjs"
if [ ! -f "$MCP_CONFIG_TOOL" ]; then
  TMP="$(mktemp -d -t chromanche-uninstall.XXXXXX)"
  MCP_CONFIG_TOOL="${TMP}/mcp-config.mjs"
  if ! curl -fsSL -o "$MCP_CONFIG_TOOL" "https://raw.githubusercontent.com/${REPO}/${REF}/scripts/lib/mcp-config.mjs" 2>/dev/null; then
    echo "!! Could not fetch config cleanup helper. CLI removals and installed files will still be removed." >&2
    MCP_CONFIG_TOOL=""
  fi
fi

if command -v claude >/dev/null 2>&1; then
  for name in "${NAMES[@]}"; do
    echo "==> Removing '${name}' MCP server registration from Claude Code (user scope)"
    claude mcp remove "$name" --scope user >/dev/null 2>&1 || true
  done
fi

if command -v codex >/dev/null 2>&1; then
  for name in "${NAMES[@]}"; do
    echo "==> Removing '${name}' MCP server registration from Codex"
    codex mcp remove "$name" >/dev/null 2>&1 || true
  done
fi

if [ -n "$MCP_CONFIG_TOOL" ]; then
  for name in "${NAMES[@]}"; do
    node "$MCP_CONFIG_TOOL" remove "$CLAUDE_CFG" "$name" || true
    node "$MCP_CONFIG_TOOL" remove "$OPENCODE_CFG" "$name" || true
    node "$MCP_CONFIG_TOOL" remove "$OPENCODE_LEGACY_CFG" "$name" || true
    node "$MCP_CONFIG_TOOL" remove "$COPILOT_CFG" "$name" || true
    node "$MCP_CONFIG_TOOL" remove-codex "$CODEX_CFG" "$name" || true
  done
fi

if [ -d "$INSTALL_DIR" ]; then
  echo "==> Removing $INSTALL_DIR"
  rm -rf "$INSTALL_DIR"
fi
if [ -d "$LEGACY_DIR" ]; then
  echo "==> Removing $LEGACY_DIR"
  rm -rf "$LEGACY_DIR"
fi

echo "==> Done. Also remove the Chromanche and legacy BrowserUse extensions from chrome://extensions."
