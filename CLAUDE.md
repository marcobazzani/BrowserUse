# BrowserUse — engineering guardrails

This project is a self-hosted alternative to "Claude in Chrome": a Chrome MV3 extension plus a local Node.js MCP server that lets Claude Code drive the user's real, logged-in Chrome. Works with any Claude Code backend (Anthropic API, AWS Bedrock, Google Vertex, self-hosted gateway). Because the agent operates on a logged-in daily browser — Gmail, banking, internal tools — regressions have real blast radius.

## Testing is non-negotiable

Every feature ships with BOTH unit tests and integration tests. No exceptions. "Just a small change" does not exempt you.

### Unit tests (vitest)

Cover pure logic with fast, isolated tests. Mock only the transport boundary.

- Zod protocol schemas must round-trip every request and response shape (valid → parse → serialize → parse again = identity).
- `BridgeServer` correlator: requests receive matching responses, unknown IDs are dropped, in-flight requests time out with a descriptive error, multiple concurrent requests don't cross-talk.
- MCP tool adapters: given a bridge stub, the adapter calls the correct wire method with correct params and returns the expected MCP content payload.
- Extension handlers (where testable in node): pure reducers on inputs → outputs.

Run with `pnpm -r test:unit`. A PR that adds a wire method without a schema round-trip test is incomplete.

### Integration tests

Cover the boundaries unit tests cannot.

- **MCP-server ↔ fake extension**: spin up the real `BridgeServer` + MCP stdio server in-process, connect a stub WebSocket client that plays the extension's role, invoke each MCP tool end-to-end, assert on both the MCP response and the messages received over the WS.
- **Extension ↔ real MCP server**: spawn the MCP server binary, load the packaged extension into a headed Chromium via Playwright's `launchPersistentContext` + `--load-extension`, and drive real tools (`tabs.list`, `page.navigate`) against live pages. This catches manifest issues, permission issues, service-worker lifetime issues, and wire-protocol drift.
- **Session UX**: assert that after a tool first touches a tab, the tab is in the "Claude" tab group AND the page contains the overlay shadow-DOM element. Assert `session.release` removes both.

Run with `pnpm -r test:integration`. If a change touches the wire protocol, the manifest, or any `chrome.*` call, an integration test must cover it.

### Red tests block merge

CI runs both tiers. A red unit or integration test blocks merge. "I'll fix it in a follow-up" is not acceptable — the follow-up never comes.

### Never replace integration tests with "manual smoke testing"

If you find yourself writing "verify manually by clicking …" in a PR description for behaviour that could be asserted in code, write the integration test instead. Manual checks exist only for truly visual/perceptual concerns (does the amber gradient look right?) and even then the DOM structure they rely on is asserted in integration tests.

## Other guardrails

- **No telemetry, no outbound network calls from the MCP server process.** This project's raison d'être is user control / data residency: the MCP server binds loopback only, and LLM traffic flows Claude Code → whichever backend the user configured, not via us. If a dependency phones home, it doesn't belong here. Periodically verify with `lsof -iTCP -sTCP:ESTABLISHED -p <mcp-pid>`.
- **Loopback only.** The MCP server's WebSocket binds `127.0.0.1` exclusively, and the extension refuses any non-loopback server.
- **Token auth on the WS bridge.** Never land a change that accepts unauthenticated connections, even "temporarily for testing."
- **Wire protocol is the single source of truth.** Both the MCP server and the extension import the same Zod schemas from `packages/shared`. A wire-method rename without a schema update is a bug.
