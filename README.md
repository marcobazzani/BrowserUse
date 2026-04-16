# BrowserUse — self-hosted "Claude in Chrome"

Lets Claude Code drive your real, logged-in Chrome via a local MCP server + MV3 extension. Works with any Claude Code setup — Anthropic API, AWS Bedrock, Google Vertex, or a self-hosted gateway. No browser data leaves your machine; the MCP server is loopback-only.

## What you get

MCP tools exposed over stdio, relayed to the extension over a localhost WebSocket (127.0.0.1, token-authed). Current set (v0.3):

- **Tabs:** `tabs_list`, `tabs_create`, `tabs_close`, `tabs_activate`
- **Navigation & read:** `page_navigate`, `page_snapshot` (text / dom / a11y), `page_screenshot`
- **Interact:** `page_click`, `page_type`, `page_scroll`
- **Escape hatch & logs:** `page_eval_js`, `console_read`, `network_read`
- **Session:** `session_release`

Every interactive tool auto-claims its target tab: the tab is put into a distinct orange **"Claude"** tab group and gets an amber pulsing border + "Claude is using this tab" pill — so you always know when the agent is driving.

## Requirements

- Node 20+ (tested on 20 LTS and newer).
- pnpm 9.x (`npm install -g pnpm@9` if not present).
- A Chromium-based browser (Chrome, Edge, Brave, Arc) — 116+.
- Claude Code (or any MCP-capable client). Works with any backend Claude Code supports.

## Quickstart

```bash
pnpm install
pnpm build
```

### 1. Install the extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select `packages/extension/dist`.

### 2. Register the MCP server with Claude Code

```bash
claude mcp add browseruse --scope user \
  -- node /ABSOLUTE/PATH/TO/BrowserUse/packages/mcp-server/dist/index.js
```

Or edit `~/.claude/settings.json` directly:

```json
{
  "mcpServers": {
    "browseruse": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/BrowserUse/packages/mcp-server/dist/index.js"]
    }
  }
}
```

### 3. First run

1. Start `claude` in any directory. The MCP server launches as a child process.
2. Its stderr prints a line like:
   `[browseruse] listening on ws://127.0.0.1:59321. Token (paste into extension popup): <hex>`
3. Click the BrowserUse toolbar icon → paste that token → **Save**. The popup flips to `Status: authed`.
4. Ask Claude: *"Open https://example.com in a new tab and tell me the page title."*
5. The new tab joins the orange "Claude" tab group and shows the amber pulsing border while the agent works.

## Testing

Unit and integration tests are non-negotiable per [CLAUDE.md](./CLAUDE.md). Run both tiers:

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

The MCP server binds `127.0.0.1` only and never makes outbound network calls — LLM traffic goes directly from Claude Code to whichever backend you've configured. Verify:

```bash
lsof -iTCP -sTCP:ESTABLISHED -p "$(pgrep -f 'mcp-server/dist/index.js')"
```

All connections shown should be loopback.

## Known limitations

- MV3 service workers can go to sleep after ~30 s idle. If tool calls hang, clicking any tab reactivates the worker; the `runtime-robustness` plan adds a keepalive.
- The overlay cannot inject into `chrome://` pages, the Chrome Web Store, or sites with particularly aggressive CSP — the tab group badge still appears, but not the border.
- Developer-mode install only (no Chrome Web Store packaging yet).
