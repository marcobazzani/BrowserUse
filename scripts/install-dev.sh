#!/usr/bin/env bash
# Chromanche DEV channel installer — convenience wrapper around install.sh
# that installs the latest CI-built dev artifact instead of the latest release.
#
# Single install: this overwrites whatever is currently at ~/.chromanche and
# replaces the existing 'chromanche' MCP entry in Claude Code / Codex /
# OpenCode / GitHub Copilot CLI. Re-run with the regular install.sh to switch
# back to stable.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/marcobazzani/Chromanche/main/scripts/install-dev.sh | bash
#
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
if [ -f "${HERE}/install.sh" ]; then
  CHROMANCHE_CHANNEL=dev exec bash "${HERE}/install.sh"
fi
# Curl-piped path: fetch install.sh from the same branch and execute it
# inline with the dev channel set.
exec env CHROMANCHE_CHANNEL=dev bash -c \
  "$(curl -fsSL "https://raw.githubusercontent.com/marcobazzani/Chromanche/main/scripts/install.sh")"
