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

## Quickstart

```bash
pnpm install
pnpm build
```

### 1. Generate an auth token

The MCP server and the extension need a shared secret so only your extension can drive the bridge. Generate one in the same terminal you'll start `claude` in:

```bash
export BROWSERUSE_TOKEN=$(openssl rand -hex 24)
echo "$BROWSERUSE_TOKEN"
```

Keep the printed value handy — you'll paste it into the extension popup in step 4. The `export` lets Claude Code inherit it when it spawns the MCP server.

> On Windows PowerShell:
> ```powershell
> $env:BROWSERUSE_TOKEN = -join ((1..24) | ForEach-Object { "{0:x2}" -f (Get-Random -Max 256) })
> echo $env:BROWSERUSE_TOKEN
> ```

### 2. Register the MCP server with Claude Code

```bash
claude mcp add browseruse --scope user \
  --env "BROWSERUSE_TOKEN=$BROWSERUSE_TOKEN" \
  -- node /ABSOLUTE/PATH/TO/BrowserUse/packages/mcp-server/dist/index.js
```

Confirm it registered:

```bash
claude mcp list
```

### 3. Install the extension

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select `packages/extension/dist`.
4. Pin the toolbar icon: click the puzzle-piece icon in Chrome's toolbar → pin **BrowserUse**.

### 4. Paste the token into the popup

1. Click the BrowserUse toolbar icon to open the popup.
2. Paste the `BROWSERUSE_TOKEN` value from step 1 into the input field.
3. Click **Save**. The popup says `Status: closed` (server isn't running yet) — that's correct.

### 5. Run

```bash
claude
```

Re-open the popup — status should now say `authed`. Try: *"Open https://example.com in a new tab and tell me the page title."* The new tab joins the orange "Claude" tab group and shows the amber pulsing border while the agent works.

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
