# BrowserUse — self-hosted "Claude in Chrome"

[![CI](https://github.com/marcobazzani/BrowserUse/actions/workflows/ci.yml/badge.svg)](https://github.com/marcobazzani/BrowserUse/actions/workflows/ci.yml)

Lets Claude Code drive your real, logged-in Chrome via a local MCP server + MV3 extension. No browser data leaves your machine; the MCP server binds `127.0.0.1` only.

## What you get

MCP tools exposed over stdio, relayed to the extension over a localhost WebSocket (token-authed). Current set (v0.4.0, 17 tools):

- **Tabs:** `tabs_list`, `tabs_create`, `tabs_close`, `tabs_activate`
- **Navigation & read:** `page_navigate`, `page_snapshot` (uid-annotated a11y tree / text / dom), `page_screenshot`
- **Interact:** `page_click`, `page_type`, `page_hover`, `page_press_key`, `page_scroll`, `page_fill_form`
- **Escape hatch & logs:** `page_eval_js`, `console_read`, `network_read`
- **Session:** `session_release`

The default `page_snapshot` mode returns a **CDP accessibility tree with stable uids** — each interactive element gets a `[uid]` you pass directly to click/type/hover. No CSS selector guessing. All interaction tools support `includeSnapshot=true` to get an updated tree in the response, reducing round-trips.

Every interactive tool auto-claims its target tab: the tab is put into a distinct orange **"Claude"** tab group and gets an amber pulsing border + "Claude is using this tab" pill — so you always know when the agent is driving.

## Requirements

- Node 20+
- A Chromium-based browser (Chrome, Edge, Brave, Arc) — 116+
- Claude Code (or any MCP-capable client)

## Quickstart (users)

One command — downloads the latest release, sets up a token, registers the MCP server with Claude Code, and prints the Chrome steps:

```bash
curl -fsSL https://raw.githubusercontent.com/marcobazzani/BrowserUse/main/scripts/install.sh | bash
```

Then follow the printed instructions (load unpacked extension + paste token). Set `BROWSERUSE_REINIT=1` before the command if you want to regenerate the token.

**Windows:** use WSL for the installer, or do it by hand — download the latest `browseruse-extension-*.zip` + `browseruse-mcp-server-*.tgz` from [Releases](https://github.com/marcobazzani/BrowserUse/releases), unpack to `%USERPROFILE%\.browseruse\`, then register the MCP server per the installer's printed instructions.

**Uninstall:**
```bash
curl -fsSL https://raw.githubusercontent.com/marcobazzani/BrowserUse/main/scripts/uninstall.sh | bash
```

## Known limitations

- The overlay cannot inject into `chrome://` pages, the Chrome Web Store, or sites with particularly aggressive CSP — the tab group badge and an orange toolbar dot still appear, but the border does not.
- Developer-mode extension install only (no Chrome Web Store listing yet — manifest and privacy policy are ready).
