#!/usr/bin/env bash
set -euo pipefail
INSTALL_DIR="${HOME}/.browseruse"

if command -v claude >/dev/null 2>&1; then
  echo "==> Removing MCP server registration from Claude Code (user scope)"
  claude mcp remove browseruse --scope user >/dev/null 2>&1 || true
fi

if [ -d "$INSTALL_DIR" ]; then
  echo "==> Removing $INSTALL_DIR"
  rm -rf "$INSTALL_DIR"
fi

echo "==> Done. Also remove the BrowserUse extension from chrome://extensions."
