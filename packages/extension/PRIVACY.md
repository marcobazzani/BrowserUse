# BrowserUse — Privacy Policy

**TL;DR: No data leaves your machine via this extension.**

## What BrowserUse does

BrowserUse is a Chrome MV3 extension that connects to a local-loopback WebSocket server (`ws://127.0.0.1:<port>`) run by a process on your own computer. That local process exposes an MCP (Model Context Protocol) server over stdio, which MCP-capable clients such as Claude Code can use to drive Chrome — open tabs, read page content, click, type, inspect logs.

## What data BrowserUse collects, transmits, or stores

- **Nothing is sent off-device by this extension.** The extension's only outbound connection is to `127.0.0.1` (your own machine). It does not contact any author-controlled server, analytics provider, CDN, or telemetry endpoint.
- **No third-party SDKs are bundled.** The build output contains only this project's code, the Zod runtime, and Chrome's built-in extension APIs.
- **Local storage** (`chrome.storage.local`) is used to remember the auth token and port you configured in the popup, and the most recent connection status. These values never leave your machine.
- **LLM traffic is not handled by this extension.** If you use Claude Code (or any other MCP client) with BrowserUse, the LLM provider that client is configured to use will see the instructions you give it — that traffic flows between the client and the provider directly, not through this extension.

## Permissions explained

- `tabs`, `tabGroups`, `activeTab` — read the list of your open tabs, create/close/activate them, and group the tabs the agent is driving under an orange "Claude" group so you can always see which tabs are being controlled.
- `scripting` — inject small pieces of JavaScript into a target tab to read the DOM, click elements, type into inputs, and draw the amber activity overlay.
- `debugger` — attach Chrome's DevTools Protocol to a tab so the agent can evaluate JavaScript, read console messages, and see network activity. Chrome displays a warning banner ("BrowserUse started debugging this browser") whenever this is active, so the user always has visibility.
- `storage` — remember the local auth token, the configured port, and the connection status between popup openings.
- `alarms` — fire a 25-second keepalive ping so Chrome doesn't park the service worker between agent operations.
- `host_permissions: <all_urls>` — required so the extension can act on whichever page the user asks the agent to drive. The extension does not automatically inject into any page; scripts are only injected in response to an explicit tool call from the local MCP server.

## What leaves your computer

- LLM requests made by your MCP client (e.g. Claude Code) go to whichever provider you've configured there — the extension does not see or intermediate those.
- No other outbound network traffic originates from this extension.

## Contact

Issues, questions: https://github.com/marcobazzani/BrowserUse/issues
