#!/usr/bin/env bash
# Removes a legacy "BrowserUse" install. BrowserUse was renamed to Chromanche
# for trademark reasons; nothing is migrated — the old install is dropped so
# the fresh Chromanche install can take over cleanly.
#
# install.sh sources this before installing. It is also runnable standalone
# and respects $HOME, so it can be exercised by integration tests against a
# temporary home directory.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_CONFIG_TOOL="${HERE}/lib/mcp-config.mjs"

LEGACY_NAME="browseruse"
LEGACY_DIR="${HOME}/.${LEGACY_NAME}"
CLAUDE_CFG="${HOME}/.claude/settings.json"
OPENCODE_CFG="${HOME}/.opencode/config.json"
COPILOT_CFG="${HOME}/.copilot/mcp-config.json"

_note() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

# Detect a legacy install: either the install dir or a registered MCP entry.
_has_legacy() {
  [ -d "$LEGACY_DIR" ] && return 0
  if command -v claude >/dev/null 2>&1 && \
     claude mcp list 2>/dev/null | grep -q "^${LEGACY_NAME}"; then
    return 0
  fi
  for cfg in "$CLAUDE_CFG" "$OPENCODE_CFG" "$COPILOT_CFG"; do
    [ -f "$cfg" ] && grep -q "\"${LEGACY_NAME}\"" "$cfg" && return 0
  done
  return 1
}

cleanup_legacy() {
  _has_legacy || return 0

  _note "BrowserUse has been renamed to Chromanche (trademark reasons)."
  _note "Removing the old BrowserUse install — nothing is migrated."

  # Claude Code: prefer the CLI; fall back to editing settings.json directly.
  if command -v claude >/dev/null 2>&1; then
    claude mcp remove "${LEGACY_NAME}" --scope user >/dev/null 2>&1 || true
  fi
  node "$MCP_CONFIG_TOOL" remove "$CLAUDE_CFG" "${LEGACY_NAME}" || true

  # OpenCode + GitHub Copilot CLI: drop the entry from their JSON configs.
  node "$MCP_CONFIG_TOOL" remove "$OPENCODE_CFG" "${LEGACY_NAME}" || true
  node "$MCP_CONFIG_TOOL" remove "$COPILOT_CFG" "${LEGACY_NAME}" || true

  # Installed files.
  rm -rf "$LEGACY_DIR"

  _note "Old BrowserUse install removed. Remove the old unpacked \"BrowserUse\""
  _note "extension at chrome://extensions — the new Chromanche extension"
  _note "replaces it (it loads with a different extension ID)."
}

# Run when executed directly (not when sourced).
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  cleanup_legacy
fi
