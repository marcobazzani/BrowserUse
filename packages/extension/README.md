# BrowserUse — Chrome Extension

Companion to the BrowserUse MCP server. This extension receives tool calls from the local server over a loopback WebSocket and executes them in Chrome (read DOM, click, type, screenshot, etc.).

**Install (unpacked):**

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click "Load unpacked" and select this folder.
4. Click the BrowserUse toolbar icon, paste your MCP server's auth token, Save.

See https://github.com/marcobazzani/BrowserUse for the full setup including the local MCP server.

Privacy: [`PRIVACY.md`](./PRIVACY.md) — no telemetry, loopback only.
