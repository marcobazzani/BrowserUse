# BrowserUse — self-hosted "Claude in Chrome" for Bedrock

Lets Claude Code (pointed at AWS Bedrock) drive your real, logged-in Chrome via a local MCP server + MV3 extension. No Anthropic-hosted services, no browser data leaves Bedrock.

## What you get

Three MCP tools exposed over stdio, relayed to the extension over a localhost WebSocket (127.0.0.1, token-authed):

- `tabs_list` — list all open tabs.
- `tabs_create` — open a new tab at a URL.
- `page_navigate` — navigate a tab to a URL.

Every tool auto-claims the affected tab: it is put into a distinct orange **"Claude"** tab group and gets an amber pulsing border + "Claude is using this tab" pill — so the user always knows when the agent is driving.

Later plans add snapshot, click, type, evalJs, screenshot, console, network, and GIF recording.

## Requirements

- Node 20+ (tested on 20 LTS and newer).
- pnpm 9.x (`npm install -g pnpm@9` if not present).
- Chrome (any recent version) for the extension.
- Access to AWS Bedrock (for Claude Code's LLM backend).

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

Add to `~/.claude/settings.json` (or a project `.mcp.json`):

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

### 3. Point Claude Code at Bedrock

Before starting Claude Code:

```bash
export CLAUDE_CODE_USE_BEDROCK=1
export AWS_REGION=eu-central-1   # or whichever region matches your data-residency needs
export ANTHROPIC_MODEL=anthropic.claude-3-5-sonnet-20241022-v2:0
# plus your AWS credentials (SSO, IAM role, etc.)
```

### 4. First run

1. Start `claude` in any directory. The MCP server launches as a child process.
2. Its stderr prints a line like:
   `[browseruse] listening on ws://127.0.0.1:59321. Token (paste into extension popup): <hex>`
3. Click the BrowserUse toolbar icon → paste that token → **Save**. The popup will flip to `Status: authed`.
4. Ask Claude: "Open https://example.com in a new tab and tell me the page title."
5. The new tab joins the orange "Claude" tab group and shows the amber pulsing border while the agent works.

## Testing

Unit and integration tests are non-negotiable per [CLAUDE.md](./CLAUDE.md). Run both tiers:

```bash
pnpm test:unit          # ~33 tests, always runs, < 2s
pnpm test:integration   # ~5 tests in mcp-server; extension e2e only when BROWSERUSE_E2E=1
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

## GDPR / data-residency sanity check

With the MCP server running, verify the only outbound connections from its PID are loopback:

```bash
lsof -iTCP -sTCP:ESTABLISHED -p "$(pgrep -f 'mcp-server/dist/index.js')"
```

The MCP server never talks to Anthropic or any third party; all LLM traffic goes Claude Code → AWS Bedrock.

## Known limitations (v0.1)

- Only three tools (`tabs_list`, `tabs_create`, `page_navigate`). Follow-up plans add `page.snapshot`, `page.click`, `page.type`, `page.evalJs`, `page.screenshot`, `console.read`, `network.read`, `gif.record`, `session.release`.
- MV3 service workers can go to sleep. If tool calls hang after Chrome has been idle, clicking any BrowserUse tab reactivates the worker; a follow-up plan adds a keepalive.
- The overlay cannot inject into `chrome://` pages, the Chrome Web Store, or sites with particularly aggressive CSP — the tab group badge still appears, but not the border.
- Developer-mode install only (no Chrome Web Store packaging).
