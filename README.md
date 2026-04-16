# BrowserUse — self-hosted "Claude in Chrome"

[![CI](https://github.com/marcobazzani/BrowserUse/actions/workflows/ci.yml/badge.svg)](https://github.com/marcobazzani/BrowserUse/actions/workflows/ci.yml)

Lets Claude Code drive your real, logged-in Chrome via a local MCP server + MV3 extension. No browser data leaves your machine; the MCP server binds `127.0.0.1` only.

## What you get

MCP tools exposed over stdio, relayed to the extension over a localhost WebSocket (token-authed). Current set (v0.3):

- **Tabs:** `tabs_list`, `tabs_create`, `tabs_close`, `tabs_activate`
- **Navigation & read:** `page_navigate`, `page_snapshot` (text / dom / a11y), `page_screenshot`
- **Interact:** `page_click`, `page_type`, `page_scroll`
- **Escape hatch & logs:** `page_eval_js`, `console_read`, `network_read`
- **Session:** `session_release`

Every interactive tool auto-claims its target tab: the tab is put into a distinct orange **"Claude"** tab group and gets an amber pulsing border + "Claude is using this tab" pill — so you always know when the agent is driving.

## Requirements

- Node 20+
- pnpm 9.x (`npm install -g pnpm@9` if not present)
- A Chromium-based browser (Chrome, Edge, Brave, Arc) — 116+
- Claude Code (or any MCP-capable client)

## Quickstart (users)

One command — downloads the latest release, sets up a token, registers the MCP server with Claude Code, and prints the Chrome steps:

```bash
curl -fsSL https://raw.githubusercontent.com/marcobazzani/BrowserUse/main/scripts/install.sh | bash
```

Then follow the printed instructions (load unpacked extension + paste token). Set `BROWSERUSE_REINIT=1` before the command if you want to regenerate the token.

**Windows:** use WSL for the installer, or do it by hand — download the latest `browseruse-extension-*.zip` + `browseruse-mcp-server-*.tgz` from [Releases](https://github.com/marcobazzani/BrowserUse/releases), unpack to `%USERPROFILE%\.browseruse\`, then follow the [manual Claude Code registration](#register-with-claude-code-manually) below.

**Uninstall:**
```bash
curl -fsSL https://raw.githubusercontent.com/marcobazzani/BrowserUse/main/scripts/uninstall.sh | bash
```

## Quickstart (contributors / from source)

```bash
git clone https://github.com/marcobazzani/BrowserUse && cd BrowserUse
pnpm install && pnpm build
export BROWSERUSE_TOKEN=$(openssl rand -hex 24)
claude mcp add browseruse --scope user \
  --env "BROWSERUSE_TOKEN=$BROWSERUSE_TOKEN" \
  -- node "$(pwd)/packages/mcp-server/dist/index.js"
```

Load unpacked from `packages/extension/dist`, paste `$BROWSERUSE_TOKEN` into the popup, Save.

### Register with Claude Code manually

If the installer can't call `claude` (e.g. `claude` isn't on PATH), add this to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "browseruse": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server/dist/index.js"],
      "env": { "BROWSERUSE_TOKEN": "<your-token>" }
    }
  }
}
```

> **Developer note:** opt in to the pre-commit unit-test hook with:
> ```bash
> git config core.hooksPath .githooks
> ```

## Testing

Unit and integration tests are non-negotiable per [CLAUDE.md](./CLAUDE.md):

```bash
pnpm test:unit          # fast, always runs
pnpm test:integration   # in-process bridge tests; extension e2e only when BROWSERUSE_E2E=1
```

The Playwright end-to-end test (extension in real Chromium ↔ real MCP server) is gated:

```bash
pnpm -F @browseruse/extension exec playwright install chromium
BROWSERUSE_E2E=1 pnpm -F @browseruse/extension test:integration
```

## Repository layout

```
BrowserUse/
├── packages/
│   ├── shared/       # Zod wire protocol (single source of truth)
│   ├── mcp-server/   # stdio MCP server + WebSocket bridge + tool adapters
│   └── extension/    # Chrome MV3 extension (service worker, handlers, popup, overlay)
├── docs/superpowers/plans/   # implementation plans
└── CLAUDE.md                 # engineering guardrails
```

## Privacy / data-residency sanity check

The MCP server binds loopback only and never makes outbound network calls — LLM traffic goes directly from Claude Code to whichever backend you've configured. Verify:

```bash
lsof -iTCP -sTCP:ESTABLISHED -p "$(pgrep -f 'mcp-server/dist/index.js')"
```

All connections shown should be `127.0.0.1`.

## Known limitations

- MV3 service workers can go to sleep after ~30 s idle. If tool calls hang, clicking any tab reactivates the worker; the `runtime-robustness` plan adds a keepalive.
- The overlay cannot inject into `chrome://` pages, the Chrome Web Store, or sites with particularly aggressive CSP — the tab group badge still appears, but not the border.
- Developer-mode install only (no Chrome Web Store packaging yet).
