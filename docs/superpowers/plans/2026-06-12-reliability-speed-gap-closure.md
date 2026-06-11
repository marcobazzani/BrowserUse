# Reliability & Speed Gap-Closure Plan (vs Playwright MCP / Chrome DevTools MCP / browser-use)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the *reliability* and *speed* gaps the rest of the field optimizes that Chromanche v0.12.0 still has — **without** copying anything that betrays the "drive the user's real, logged-in, visible browser" spirit. After a feature-by-feature audit of Playwright MCP, Chrome DevTools MCP (Puppeteer), and browser-use, four genuine, spirit-compatible gaps remain:

1. **`page_wait for:"text"`** — wait for visible text to appear/disappear. The most natural wait an LLM reasons about ("wait for 'Payment complete'"). Playwright MCP and CDP MCP both make text the primary wait; we don't have it.
2. **Snapshot diffing (`page_snapshot since:"last"`)** — the one real *speed/cost* lever. Every interaction tool can re-emit the full a11y tree; Playwright's CLI pitch and CDP MCP's `--slim` exist precisely because re-sending the whole tree burns context and slows the agent loop. A "changed-since-last-snapshot" mode cuts tokens → faster, cheaper loops.
3. **`network_get_request`** — pull one request's headers + body. `network_read` only returns a {method,url,status,duration} buffer; for Office365 / Power Automate / Graph debugging that's the difference between "it 500'd" and "here's why." Read-only, observational.
4. **Configurable action/navigation timeouts** — small reliability knob for slow corporate networks; our actionability gate (5s) and `page_navigate` (30s) are hardcoded.

**Explicitly NOT in scope (off-spirit or off-product — same reasoning as the Office365 plan):**
- **Usage telemetry** (CDP MCP ships it default-on) — violates our no-telemetry guardrail. Never.
- **Stealth / anti-detection / proxy rotation / CAPTCHA solving** (browser-use, Playwright stealth) — serve scraping/evasion against *other people's* sites; Chromanche drives *your own* logged-in browser, so they're irrelevant and anti-spirit.
- **Performance traces / heap snapshots / Lighthouse** (CDP MCP bulk) — a devtools-profiling product, not an agent-reliability feature.
- **Request interception / route-mocking, storage-state import, emulation** — already rejected in the Office365 plan for the same spirit reasons.
- **`page_drop` (OS-level file drop)** — real but niche; deferred, not rejected. Add later if usage demands.

**Chromanche-spirit invariants (unchanged — do not violate):**
- uid/a11y-first; selector as fallback; selector resolution stays main-frame-only.
- Observational tools never claim/overlay a tab they aren't acting on.
- Read-only/observe, never exfiltrate: `network_get_request` reports only what the page already fetched; no new outbound network from the server process.
- Loopback-only, token-gated, **no telemetry, no new runtime dependencies**.
- Wire protocol is the single source of truth: every schema change lands in `packages/shared` first, with a round-trip test, consumed by both sides.
- Every feature ships with BOTH unit and integration tests. Do NOT auto-version/tag/release.

**Tech Stack:** TypeScript, Zod, Vitest, CDP (`chrome.debugger` 1.3), Chrome MV3, Playwright (integration tests).

---

## Sequencing

```
Task 1  page_wait for:"text"        ── tiny, highest LLM-ergonomics payoff; do first
Task 2  network_get_request         ── independent; read-only observability
Task 3  configurable timeouts       ── independent; small knobs
Task 4  snapshot diff (since:"last")── largest; the real speed lever; do last
```

Tasks 1–3 are small and independently shippable. Task 4 is the meaty one and benefits from landing after the others so the snapshot-manager change is isolated.

---

## Task 1: `page_wait for:"text"`

**The gap:** `page_wait` covers uid/selector/function/response/loadstate but not "wait until this text is visible (or gone)." It's the wait an LLM most naturally expresses and both reference MCPs lead with it.

**Design:** Add `"text"` to the `for` enum and a `text: string` field. Poll in-page: case-insensitive substring match against `document.body.innerText` (visible text only — not innerHTML, so hidden markup doesn't false-positive). Honor `state` so `visible` = text present, `hidden` = text absent. Main-frame only (consistent with selector mode); document that. Reuses the existing poll/timeout loop in `page-wait.ts`.

**Files:**
- Modify `packages/shared/src/protocol.ts` — add `"text"` to `PageWaitParamsSchema.for`, add `text` field, extend the superRefine (`for:"text"` requires `text`).
- Modify `packages/shared/test/protocol.test.ts` — round-trip + "requires text" rejection.
- Modify `packages/extension/src/handlers/page-wait.ts` — `case "text"` branch.
- Modify `packages/extension/test/handlers.unit.test.ts` — text present resolves; absent times out.
- Modify `packages/mcp-server/src/tools.ts` — extend `page_wait` description (no schema change beyond shared). Text mode acts on a page we drive → it DOES claim (unlike response mode).
- Modify `packages/mcp-server/test/server.integration.test.ts` — text-mode wait round-trips.
- Modify `packages/extension/test/e2e.integration.test.ts` — wait for delayed text against real Chromium.
- Modify `README.md` — note text mode under the Wait group.

- [ ] **Step 1: Failing schema test.** In `protocol.test.ts`:
```ts
it("page.wait text mode round-trips", () => {
  const p = PageWaitParamsSchema.parse({ tabId: 1, for: "text", text: "Payment complete" });
  expect(p.for).toBe("text");
  expect(p.text).toBe("Payment complete");
});
it("page.wait text mode requires text", () => {
  expect(() => PageWaitParamsSchema.parse({ tabId: 1, for: "text" })).toThrow();
});
```
- [ ] **Step 2:** Run shared unit → confirm fail.
- [ ] **Step 3: Schema.** Add `"text"` to the `for` enum, add `text: z.string().min(1).optional()`, and in superRefine: `if (v.for === "text" && !v.text) ctx.addIssue({ code: "custom", message: "for=text requires text" });`. Run → pass.
- [ ] **Step 4: Handler.** In `page-wait.ts`, add:
```ts
case "text": {
  const r = await mgr.sendCommand<{ result: { value: boolean } }>(
    p.tabId, "Runtime.evaluate",
    { expression: `(document.body?.innerText || "").toLowerCase().includes(${JSON.stringify(p.text!.toLowerCase())})`, returnByValue: true },
  );
  const present = !!r.result.value;
  satisfied = p.state === "hidden" || p.state === "detached" ? !present : present;
  break;
}
```
- [ ] **Step 5: Handler unit tests.** Drive the fake `Runtime.evaluate` to return false then true; assert resolve. Never-true with small timeout → reject `/timed out/`.
- [ ] **Step 6: MCP description + claim.** Add text mode to the `page_wait` description; text mode claims (it's acting on a driven page). No wrapper-logic change needed — only `response` is in the no-claim branch.
- [ ] **Step 7: Integration tests** (in-process bridge + real Chromium with a `setTimeout`-injected text node).
- [ ] **Step 8: README + commit.**

---

## Task 2: `network_get_request` — single request headers + body

**The gap:** `network_read` returns a buffer of summaries; you can't inspect one request's headers/body. For debugging a failed Power Automate / Graph call this is the missing piece. Read-only and observational — fully on-spirit (it reports only what the page already fetched; the server makes no outbound call).

**Design:** New wire method `network.getRequest`. The extension's `DebuggerManager` already buffers network events via CDP `Network.*`. Extend it to retain a bounded map of `requestId → { request headers, response headers, status }` and lazily fetch the body via CDP `Network.getResponseBody` on demand (bodies aren't buffered eagerly — too heavy; fetched only when asked). Address a request by the `url`+`ts` (or an index) the model already saw from `network_read`. Cap body bytes (reuse the `maxBytes` pattern from `page_fetch`). Redact nothing by default but document that bodies may contain sensitive data (it's the user's own session — consistent with `page_fetch`).

**Files:**
- Modify `packages/shared/src/protocol.ts` — `NetworkGetRequestParamsSchema` ({ tabId?, url (regex or exact), index?, maxBytes }) + result ({ method, url, status, requestHeaders, responseHeaders, body, truncated }) + METHODS entry.
- Modify `packages/shared/test/protocol.test.ts` — round-trip + validation.
- Modify `packages/extension/src/lib/debugger-manager.ts` — retain headers/status keyed by requestId in the ring buffer (bounded), expose a `getRequestDetail(...)` that calls `Network.getResponseBody`.
- Modify `packages/extension/src/handlers/debug.ts` (or wherever console/network handlers live) — register `network.getRequest`.
- Modify `packages/extension/test/debugger-manager.unit.test.ts` + `handlers.unit.test.ts` — buffer retains headers; handler returns detail; body fetch is lazy.
- Modify `packages/mcp-server/src/tools.ts` — `network_get_request` wrapper. Observational → does NOT claim. Add to `BATCHABLE_TOOLS` (cheap, composable). Registry + returned map.
- Modify `packages/mcp-server/test/tools.unit.test.ts` + `server.integration.test.ts` — wrapper forwards, no claim.
- Modify `README.md` — under Network/JS group.

- [ ] **Step 1:** Failing schema test → schema → pass.
- [ ] **Step 2:** Extend `DebuggerManager`: on `Network.responseReceived` also store `responseHeaders`+`status`; on `Network.requestWillBeSent` store `requestHeaders`. Bound the detail map to the same cap as the ring buffer; evict oldest. Add `async getRequestDetail(tabId, match, maxBytes)` → find newest matching buffered entry, call `Network.getResponseBody({ requestId })`, truncate.
- [ ] **Step 3:** Failing handler unit test (fake `Network.getResponseBody`) → implement `network.getRequest` → pass.
- [ ] **Step 4:** MCP wrapper (no claim) + unit test asserting no `session.claim`.
- [ ] **Step 5:** Integration test over the in-process bridge.
- [ ] **Step 6:** README + commit.

> Spirit note in code comment: this surfaces only requests the page itself already made, on the user's own session — same trust model as `page_fetch`. No new outbound traffic from the server. Cite CLAUDE.md data-residency.

---

## Task 3: Configurable action / navigation timeouts

**The gap:** the actionability gate is a hardcoded 5s (`page-interact.ts waitForActionable`), `page_navigate` waits a hardcoded 30s (`page.ts`). Slow corporate networks (the exact Office365 environment) need tuning without forcing `force:true`.

**Design:** Add optional `timeoutMs` to `PageClickParamsSchema` and `PageTypeParamsSchema` (default 5000, the current value) threaded into `waitForActionable`. Add optional `timeoutMs` to `PageNavigateParamsSchema` (default 30000) threaded into `waitForTabLoad`. No behaviour change at defaults — pure additive knobs.

**Files:**
- Modify `packages/shared/src/protocol.ts` — add `timeoutMs` (positive int, capped, defaulted) to the three schemas.
- Modify `packages/shared/test/protocol.test.ts` — defaults + round-trip.
- Modify `packages/extension/src/handlers/page-interact.ts` — pass `p.timeoutMs` into `waitForActionable`.
- Modify `packages/extension/src/handlers/page.ts` — pass `p.timeoutMs` into `waitForTabLoad`.
- Modify `packages/extension/test/handlers.unit.test.ts` — a small `timeoutMs` makes the hidden-element click fail fast (replaces the fake-timers dance with a real short timeout — cleaner test).
- Modify `packages/mcp-server/src/tools.ts` — mention the knob in click/type/navigate descriptions.
- Modify `README.md` if descriptions materially change.

- [ ] Standard ladder: failing schema test → schema (defaults preserve current behaviour) → pass → handler threading → unit test (fast-fail with small timeout) → integration sanity → commit. Keep defaults identical so zero regression.

---

## Task 4: Snapshot diffing — `page_snapshot since:"last"` (the speed lever)

**The gap:** the biggest *speed/cost* differentiator the field optimizes and we don't. Every `page_snapshot` (and every `includeSnapshot:true`) re-emits the entire uid-annotated a11y tree. On a heavy Office365 page that's thousands of tokens per step → slow, expensive agent loops. Playwright's CLI-over-MCP pitch and CDP MCP's `--slim` both exist to fight this.

**Design:** Add an opt-in `since: "last"` to `page_snapshot` (default unchanged = full tree). When set, the snapshot-manager computes the new tree as today but returns only **lines that changed since the previous snapshot of that tab** — additions, removals, and attribute/text changes — plus a stable header (url/title) and a compact summary (`+N -M ~K`, total nodes). uids stay stable across the diff so the model can still click/type by uid. If there's no prior snapshot for the tab, `since:"last"` transparently returns the full tree (and records it as the baseline). This is purely a *response-shaping* change — the underlying capture is identical, so OOPIF handling, bounds, etc. all still work.

**Why this is spirit-safe:** it's an efficiency optimization on data we already produce, fully local, no new permissions, no behaviour change unless opted in. It makes the agent loop faster and cheaper — directly serving the user.

**Files:**
- Modify `packages/shared/src/protocol.ts` — add `since: z.enum(["full","last"]).default("full")` to `PageSnapshotParamsSchema`; add `diff?: { added: number; removed: number; changed: number }` + `baseline: boolean` to the result.
- Modify `packages/shared/test/protocol.test.ts` — defaults + round-trip.
- Modify `packages/extension/src/lib/snapshot-manager.ts` — retain the previous rendered lines per tab (already keyed by tab); add a line-level diff (the lines are already deterministic, uid-prefixed strings). Return changed lines + counts when `since:"last"` and a baseline exists; else full + `baseline:true`.
- Modify `packages/extension/src/handlers/page-read.ts` — thread `since` through; populate `diff`/`baseline` in the result.
- Modify `packages/extension/test/handlers.unit.test.ts` — first `since:"last"` returns baseline=full; after a simulated DOM change, second returns only changed lines + correct counts.
- Modify `packages/mcp-server/src/tools.ts` — document `since:"last"` in `page_snapshot` (and note interaction tools' `includeSnapshot` still returns full unless a future flag is added — keep scope tight).
- Modify `packages/mcp-server/test/server.integration.test.ts` — `since:"last"` round-trips diff metadata.
- Modify `packages/extension/test/e2e.integration.test.ts` — real-Chromium: full baseline, mutate the DOM, diff returns only the new node.
- Modify `README.md` — document under Navigation & read; frame as a token/speed optimization.

- [ ] **Step 1:** Failing schema test (`since` default `"full"`, round-trip) → schema → pass.
- [ ] **Step 2:** Failing snapshot-manager unit test: capture, then capture again with a changed node, assert diff lines + counts; assert first `since:"last"` with no baseline returns full + `baseline:true`. → implement line diff → pass.
- [ ] **Step 3:** Thread through `page-read.ts`; populate result fields.
- [ ] **Step 4:** Handler unit tests (a11y diff path).
- [ ] **Step 5:** MCP description; keep `includeSnapshot` semantics unchanged this round (full tree) to bound scope — note as a follow-up.
- [ ] **Step 6:** Integration tests (in-process + real Chromium DOM mutation).
- [ ] **Step 7:** README + commit.

> Scope guard: this task only adds `since:"last"` to the explicit `page_snapshot` tool. Wiring diff into every `includeSnapshot:true` response is a tempting follow-up but doubles the surface and the test matrix — keep it out of this plan; revisit once the explicit path is proven.

---

## Cross-cutting verification

- [ ] `pnpm -r test:unit` green.
- [ ] `pnpm -r test:integration` green (in-process bridge).
- [ ] `CHROMANCHE_E2E=1` extension integration green run **serially** (`--no-file-parallelism --poolOptions.forks.singleFork=true`) — the parallel run flakes on shared-derived-port contention (pre-existing harness limitation; each file passes alone). Kill any stale `~/.chromanche/mcp-server` processes first — they steal the derived leader port.
- [ ] `pnpm -r build` clean.
- [ ] Guardrails: loopback-only binding unchanged; **no new manifest permission** (none of these need one); **no new runtime dependency**; no telemetry; no new server-side outbound network (`network_get_request` reads buffered CDP data + `Network.getResponseBody`, both in-page).
- [ ] Do NOT version-bump, tag, or release.

## Self-review

1. **Coverage:** the four implemented tasks map 1:1 to the audited reliability/speed gaps (wait-for-text, single-request inspection, timeout knobs, snapshot diffing). ✓
2. **Spirit:** every item is observe-only or a local efficiency knob; the off-spirit field features (telemetry, stealth, interception, profiling) are explicitly rejected with reasons. ✓
3. **Test discipline:** shared round-trip + extension unit + integration (in-process and, where a real-browser contract exists, headed Chromium) per CLAUDE.md. ✓
4. **No protocol drift:** `page.wait` enum extension, `network.getRequest` new method, timeout params, and `page.snapshot since` all land in `packages/shared` first. ✓
5. **No premature release.** ✓
