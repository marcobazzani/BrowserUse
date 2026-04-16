# Runtime robustness

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development

**Goal:** Six focused fixes that don't add features but make BrowserUse behave predictably in daily use. Each task is independent and can be implemented in any order; commit one per task to keep review diffs small.

---

### Task 1: MV3 service-worker keepalive

**Problem:** Chrome parks the SW after ~30 s of inactivity. The outbound WebSocket dies. Claude's next tool call blocks until another event wakes the SW.

**Fix:** use `chrome.alarms` to wake the SW every 25 s and ping the MCP server (an ignored no-op message over the existing WS is enough to reset Chrome's idle timer).

**Files:**
- Modify: `packages/extension/src/background.ts`
- Modify: `packages/extension/manifest.json` — add `"alarms"` to `permissions`
- Modify: `packages/extension/src/ws-client.ts` — expose a `ping()` method that sends `{type:"ping"}` when connected
- Modify: `packages/mcp-server/src/bridge.ts` — accept and ignore `{type:"ping"}` frames after auth
- Modify: `packages/mcp-server/test/bridge.integration.test.ts` — add test: sending a ping doesn't interfere with call/response correlation

Background wiring:
```ts
// background.ts
chrome.alarms.create("keepalive", { periodInMinutes: 25 / 60 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "keepalive") client.ping(); });
```

Commit: `fix(extension): keep MV3 service worker alive with 25s alarm ping`

---

### Task 2: Port configurability in the extension

**Problem:** `packages/extension/src/background.ts:15` hardcodes `59321`. If a user sets `BROWSERUSE_PORT` on the server, the extension can't find it.

**Fix:** read the port from `chrome.storage.local.port`; popup lets the user override it; default remains `59321`.

**Files:**
- Modify: `packages/extension/src/background.ts` — read `port` from storage, recompute URL, restart client on port change (reuse the existing `chrome.storage.onChanged` watcher).
- Modify: `packages/extension/src/popup/index.html` + `popup.js` — add an input for port with validation (1-65535, integer).

Acceptance: popup allows changing port; saving port triggers reconnect; default unchanged.

Commit: `feat(extension): configurable WebSocket port via popup + storage`

---

### Task 3: Clean up vite output filenames

**Problem:** The popup JS is emitted as `assets/index.html-HASH.js`. The `.html` in the filename has triggered a MIME-sniff issue once. Safer to rename.

**Fix:** vite `rollupOptions.output.entryFileNames` + `assetFileNames` + `chunkFileNames` with predictable names.

**File:** `packages/extension/vite.config.ts`

```ts
build: {
  outDir: "dist",
  emptyOutDir: true,
  rollupOptions: {
    output: {
      entryFileNames: "assets/[name]-[hash].js",
      chunkFileNames: "assets/chunk-[name]-[hash].js",
      assetFileNames: "assets/[name]-[hash][extname]",
    },
  },
},
```

Verify after build: `packages/extension/dist/assets/` contains a file named like `popup-*.js` (NOT `index.html-*.js`). Extension still works in Chrome.

Commit: `fix(extension): cleaner asset filenames (no .html in .js names)`

---

### Task 4: Token fingerprinting in MCP server stderr

**Problem:** the full token is printed to stderr in cleartext. Any process that can read Claude Code's subprocess stderr can read the token.

**Fix:** print only the first 8 chars of the token + the absolute path of `~/.browseruse/token`. The user can `cat` the file themselves when they need the full value.

**File:** `packages/mcp-server/src/index.ts`

Replace the current:
```ts
console.error(
  `[browseruse] listening on ws://127.0.0.1:${cfg.port}. Token (paste into extension popup): ${cfg.token}`
);
```
with:
```ts
const prefix = cfg.token.slice(0, 8);
console.error(
  `[browseruse] listening on ws://127.0.0.1:${cfg.port}. Token prefix: ${prefix}... (full token at ${cfg.tokenFile})`
);
```

Update the README's first-run steps to tell the user to `cat ~/.browseruse/token`.

Commit: `fix(mcp-server): redact full token from stderr; point to tokenFile instead`

---

### Task 5: Overlay CSP fallback — action badge

**Problem:** on `chrome://` pages, the Chrome Web Store, or pages with strict CSP, `chrome.scripting.executeScript` silently fails. Tab is still in the "Claude" tab group (visible in the tab strip), but the amber border is absent. The user may not notice the agent is still driving.

**Fix:** if `injectOverlay` catches an error, set a red badge on the toolbar icon via `chrome.action.setBadgeText`. Clear on `session.release` or when the overlay DOES inject elsewhere.

**File:** `packages/extension/src/handlers/session.ts`

```ts
async function injectOverlay(tabId: number) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: overlayIn });
    await chrome.action.setBadgeText({ tabId, text: "" });
  } catch {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#FF8C00" });
    await chrome.action.setBadgeText({ tabId, text: "●" });
  }
}

async function removeOverlay(tabId: number) {
  await chrome.scripting.executeScript({ target: { tabId }, func: overlayOut }).catch(() => {});
  await chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
}
```

Unit test: force the fake `chrome.scripting.executeScript` to throw; assert the badge is set.

Commit: `fix(extension): toolbar badge fallback when overlay injection blocked by CSP`

---

### Task 6: Playwright e2e test rewrite

**Problem:** the existing `e2e.integration.test.ts` has two bugs noted during Task 6 review:
1. `beforeAll` spawns one MCP server on port 59322; each test then uses `StdioClientTransport` to spawn a **second** server on the same port → collision.
2. `chrome.storage` is undefined in Playwright's service-worker `evaluate()` context in the current setup.

**Fix:** re-architect so there is ONE MCP server process. The test connects to its bridge via a WebSocket client (not via MCP), driving tool execution indirectly by feeding requests that the MCP server forwards to the extension. But that breaks the one-authed-client rule.

Simpler fix: flip the ownership. The test uses `StdioClientTransport` to spawn the only server — this is how Claude Code would do it — and the test extracts the token via the transport's `stderr` stream. The Playwright extension then auths against that server using the same token.

**File:** `packages/extension/test/e2e.integration.test.ts`

Pseudocode sketch (adjust to match MCP SDK API):

```ts
const transport = new StdioClientTransport({
  command: "node",
  args: [serverEntry],
  env: { ...process.env, BROWSERUSE_PORT: "59322", BROWSERUSE_TOKEN: "known-test-token-12345678" },
});
// transport.stderr is readable — tee it to capture the listening line if needed
await client.connect(transport);
// Now configure Playwright's extension storage with the SAME known token
await bg.evaluate((t) => chrome.storage.local.set({ token: t }), "known-test-token-12345678");
// Wait for the extension to (re)connect to the server
// Then call tools
```

Key insight: set `BROWSERUSE_TOKEN` in env → server uses that exact token → extension authenticates with the same value → no stderr scraping needed.

The `chrome.storage` undefined issue: in Playwright's `launchPersistentContext` + `--load-extension`, the service worker context should have the `chrome` API. If `chrome.storage` is undefined, the SW hasn't fully initialized — add `await ctx.waitForEvent("serviceworker")` before the `evaluate`, and retry the evaluate with a small delay.

Commit: `fix(extension/e2e): single-server lifecycle + shared BROWSERUSE_TOKEN`

---

### Manual verification after all six tasks

- [ ] Kill `claude`; wait 60 s; re-open popup — status should still be `authed` or reconnect promptly (Task 1 keepalive).
- [ ] Change port in popup to 59322; also start server with `BROWSERUSE_PORT=59322`; verify reconnect (Task 2).
- [ ] `ls packages/extension/dist/assets/` — no file has `.html` in its .js name (Task 3).
- [ ] Start `claude`; stderr shows `Token prefix: XXXXXXXX...` and the path to the file (Task 4).
- [ ] Open a `chrome://settings` tab; ask Claude to claim it — toolbar icon shows an orange dot (Task 5).
- [ ] `BROWSERUSE_E2E=1 pnpm -F @browseruse/extension test:integration` — passes on a proper workstation (Task 6).

## Out of scope

- Full authentication handshake (server-to-extension ACK frame). The current design assumes the first frame after hello is a legitimate RPC response. Good enough for a personal tool.
- Automatic port discovery (extension scans ports). Too magic; explicit port config is easier to reason about.
