# Office365 / Forms / Excel / Power Automate Gap-Closure Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Microsoft Forms / Excel for the Web / Power Automate class of apps reliable for an agent driving the user's **real, logged-in Chrome** — Chromanche's whole point. These apps are heavy async SPAs with virtualized grids; today the agent races their lazy loading and has no way to bulk-fill a grid or know when content has settled. We add the missing *human-grade* primitives a person uses on these apps without thinking: **paste a block into a grid**, **wait for the thing to appear**, **catch the file it just downloaded**, **don't click something that isn't really clickable yet**, **wheel-scroll a grid to load more rows**, and **hold modifiers while typing** (Excel range selection). Playwright is cited only as a reference for what's table-stakes — Chromanche is **not** trying to become Playwright.

**Why these six (in Chromanche terms):** Chromanche is vision + accessibility-tree driven and mirrors *Claude in Chrome*'s action shapes, not a scripted CSS test runner. So every primitive here is **uid/a11y-first, selector as fallback**, observational rather than controlling, and never fights the user's browser. They turn flaky guess-and-screenshot loops into deterministic ones for exactly the apps people live in all day. We deliberately do NOT add request interception, storage-state import, emulation, or throwaway-context tricks — those belong to Playwright's "controlled disposable browser" model and actively conflict with Chromanche's "this is your real, logged-in browser, and you can see the agent using it" premise.

**Chromanche-spirit invariants (from CLAUDE.md + README — do not violate):**
- **It's the user's real browser.** Never drive it in ways a watching human would find alien or hidden. Prefer `chrome.*` APIs and real input events over flags that reconfigure the browser's behaviour (e.g. do NOT use CDP `Page.setDownloadBehavior` to redirect downloads — let them land where the user's Chrome already puts them).
- **Human-in-the-loop visibility stays intact.** Every interactive tool already auto-claims its tab into the amber "Agent" group with the overlay; new tools that touch a tab follow the same `ensureClaim` path. Observational tools (wait-for-condition, read-only) must NOT silently claim if they don't act.
- **Data residency / least exposure.** No telemetry, no outbound network, loopback only, token-gated WS — none of these tasks touch the transport, so they stay intact (verify after). New tools NEVER enumerate or exfiltrate user data they weren't explicitly pointed at (esp. downloads: report only what was downloaded *after* the agent armed the wait, never the history).
- **uid/a11y first.** Match `resolveElement`'s existing posture: prefer `uid` (from a snapshot), accept `selector` as a fallback, and keep selector resolution main-frame-only — don't introduce surprise cross-frame traversals.
- **Wire protocol is the single source of truth:** every new wire method gets a Zod schema in `packages/shared/src/protocol.ts` AND a round-trip test; both sides import the same schema.
- **Every feature ships with BOTH unit and integration tests.** No exceptions.
- **Do NOT auto-version, auto-tag, or release.** Land code + tests + build, then stop.

**Tech Stack:** TypeScript, Zod, Vitest, CDP (`chrome.debugger` 1.3), Chrome MV3, Playwright (integration tests via `launchPersistentContext` + `--load-extension`).

---

## Sequencing & dependencies

```
Task 0  (page_paste — already specced separately) ── prerequisite for Excel bulk fill
   │
Task 1  page_wait                ── no deps, do first (everything else benefits)
   │
Task 2  actionability helper     ── depends on nothing; consumed by Task 3
   │
Task 3  auto-wait in click/type  ── depends on Task 2 helper
   │
Task 4  page_wait_for_download   ── depends on Task 1 (shares wait infra) + manifest "downloads" perm
   │
Task 5  page_scroll wheel mode   ── independent
   │
Task 6  page_type modifiers      ── independent
```

Land in this order. Tasks 1, 5, 6 are independently shippable. Task 0 (`page_paste`) already has its own plan at `docs/superpowers/plans/2026-05-08-page-paste.md` — **implement that first** if not yet done; it is the single biggest Excel win and a prerequisite for the Excel integration test in Task 1.

---

## Task 1: `page_wait` — explicit waiting primitive

**The gap:** No `waitForSelector` / `waitForFunction` / `waitForResponse` / `waitForLoadState`. Only `page.navigate` waits; everything else relies on a fixed 150ms sleep (`page-interact.ts:113`). Power Automate's lazy canvas and Office365's async chrome race this constantly.

**Design:** One tool, `page_wait`, with a discriminated `for` field so the model picks the wait kind. Modes: `uid` (preferred — wait for a uid from the last snapshot to become visible/hidden/detached), `selector` (fallback, main-frame only), `function` (truthy JS expression), `response` (a request matching `urlPattern` appears in the existing network buffer), `loadstate` (`load`/`domcontentloaded`/`networkidle`). Polls in-page via CDP `Runtime.evaluate`/`callFunctionOn`, or watches the existing network ring buffer, reusing `page.navigate`'s readiness pattern for loadstate. Single `timeoutMs` with a clear timeout error. **Claim discipline:** `page_wait` is *observational* — it does NOT claim/overlay a tab it isn't already driving. The MCP wrapper claims only when the agent passes a `tabId` it's already acting on; pure "wait for a network response" must not silently pull a tab into the Agent group.

**Files:**
- Modify `packages/shared/src/protocol.ts` — `PageWaitParamsSchema` + `PageWaitResultSchema` + `METHODS` entry.
- Modify `packages/shared/test/protocol.test.ts` — round-trip + validation tests.
- Create `packages/extension/src/handlers/page-wait.ts` — `page.wait` handler (keep `page-interact.ts` from growing further). Reuse `resolveUid` from `snapshot-manager.ts` for uid mode.
- Modify `packages/extension/src/handlers/index.ts` — register the new handler.
- Modify `packages/extension/test/handlers.unit.test.ts` — unit tests (uid resolves+visible, function becomes true, timeout throws).
- Modify `packages/mcp-server/src/tools.ts` — `page_wait` wrapper, add to `BATCHABLE_TOOLS`, registry, returned map.
- Modify `packages/mcp-server/test/tools.unit.test.ts` — wrapper test (forward; claims only when already acting).
- Create `packages/mcp-server/test/page-wait.integration.test.ts` — wait for a dynamically-injected element against headed Chromium.
- Modify `README.md` — list `page_wait`, bump tool count.

- [ ] **Step 1: Failing schema test.** In `protocol.test.ts` add:
```ts
it("page.wait uid mode round-trips with default state=visible", () => {
  const p = PageWaitParamsSchema.parse({ tabId: 1, for: "uid", uid: "e7" });
  expect(p.for).toBe("uid");
  expect(p.state).toBe("visible");
  expect(p.timeoutMs).toBe(10_000);
});
it("page.wait uid mode requires uid", () => {
  expect(() => PageWaitParamsSchema.parse({ tabId: 1, for: "uid" })).toThrow();
});
it("page.wait selector mode round-trips (fallback path)", () => {
  expect(PageWaitParamsSchema.parse({ tabId: 1, for: "selector", selector: "#ok" }).selector).toBe("#ok");
});
it("page.wait function mode requires expression", () => {
  expect(() => PageWaitParamsSchema.parse({ tabId: 1, for: "function" })).toThrow();
});
it("page.wait response mode requires urlPattern", () => {
  expect(() => PageWaitParamsSchema.parse({ tabId: 1, for: "response" })).toThrow();
});
it("page.wait loadstate accepts load/domcontentloaded/networkidle", () => {
  expect(PageWaitParamsSchema.parse({ tabId: 1, for: "loadstate", loadState: "networkidle" }).loadState).toBe("networkidle");
});
```

- [ ] **Step 2: Run, confirm fail** — `pnpm --filter @chromanche/shared test:unit`.

- [ ] **Step 3: Add schema** in `protocol.ts` after `PageScrollResultSchema`:
```ts
/* ---------- Wait (uid / selector / function / response / loadstate) ---------- */
export const PageWaitParamsSchema = z
  .object({
    tabId: z.number().int(),
    for: z.enum(["uid", "selector", "function", "response", "loadstate"]),
    // uid mode (preferred) — a uid from the most recent snapshot
    uid: z.string().min(1).optional(),
    // selector mode (fallback, main-frame only)
    selector: z.string().min(1).optional(),
    state: z.enum(["attached", "visible", "hidden", "detached"]).default("visible"),
    // function mode — JS expression that must evaluate truthy
    expression: z.string().min(1).optional(),
    // response mode — regex tested against request URL in the network buffer
    urlPattern: z.string().min(1).optional(),
    // loadstate mode
    loadState: z.enum(["load", "domcontentloaded", "networkidle"]).default("load"),
    pollMs: z.number().int().min(50).max(2_000).default(150),
    timeoutMs: z.number().int().positive().max(120_000).default(10_000),
    includeSnapshot: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.for === "selector" && !v.selector) ctx.addIssue({ code: "custom", message: "for=selector requires selector" });
    if (v.for === "function" && !v.expression) ctx.addIssue({ code: "custom", message: "for=function requires expression" });
    if (v.for === "response" && !v.urlPattern) ctx.addIssue({ code: "custom", message: "for=response requires urlPattern" });
  });
export const PageWaitResultSchema = z.object({
  ok: z.literal(true),
  matched: z.boolean(),       // true if condition met, false only when timed out and we chose not to throw (we DO throw — kept for forward compat)
  waitedMs: z.number(),
  snapshot: z.string().optional(),
}).strict();
```
Add the superRefine after `.strict()`:
```ts
  .superRefine((v, ctx) => {
    if (v.for === "uid" && !v.uid) ctx.addIssue({ code: "custom", message: "for=uid requires uid" });
    if (v.for === "selector" && !v.selector) ctx.addIssue({ code: "custom", message: "for=selector requires selector" });
    if (v.for === "function" && !v.expression) ctx.addIssue({ code: "custom", message: "for=function requires expression" });
    if (v.for === "response" && !v.urlPattern) ctx.addIssue({ code: "custom", message: "for=response requires urlPattern" });
  });
```
Add to `METHODS`: `"page.wait": { params: PageWaitParamsSchema, result: PageWaitResultSchema },`. Export the schema name in `packages/shared/src/index.ts` if it re-exports explicitly.

- [ ] **Step 4: Run, confirm pass** — shared unit tests green.

- [ ] **Step 5: Implement handler** — create `packages/extension/src/handlers/page-wait.ts`. **uid mode (preferred):** `resolveUid(tabId, uid)` → `DOM.resolveNode` (in the entry's `targetId` session, so OOPIFs work) → poll a `Runtime.callFunctionOn` visibility predicate on the objectId; honors `state` (visible/hidden/attached/detached). This is the path the agent should normally use because it matches the a11y-snapshot-driven flow. **selector mode (fallback):** poll `Runtime.evaluate` with an in-page `document.querySelector` + visibility check (`getClientRects().length` and `getComputedStyle().visibility !== "hidden"`), main-frame only. **function mode:** `Runtime.evaluate({ expression, returnByValue:true })` truthy. **response mode:** poll `mgr.readNetwork(tabId, urlPattern, sinceTs)` (record `sinceTs = Date.now()` at entry — only match NEW requests, never replay history). **loadstate:** `networkidle` = no new network-buffer entries for 500ms; `load`/`domcontentloaded` reuse the readiness pattern from `page.ts:4-20`. On timeout throw `new Error(\`page.wait timed out after \${timeoutMs}ms waiting for \${p.for}\`)`.

- [ ] **Step 6: Register** in `handlers/index.ts`:
```ts
import { registerPageWaitHandlers } from "./page-wait.js";
// ...
registerPageWaitHandlers(d, mgr);
```

- [ ] **Step 7: Handler unit tests** in `handlers.unit.test.ts` — uid mode: snapshot first, then drive the fake debugger so the visibility predicate returns falsy then truthy across polls (assert it resolves); assert a never-true predicate rejects with a timeout message when `timeoutMs` is small.

- [ ] **Step 8: MCP wrapper** in `tools.ts` — `page_wait` tool with `inputSchema: withProfile(PageWaitParamsSchema)`, forward to `page.wait`. **Claim discipline:** call `ensureClaim` only for `for` in `{"uid","selector","function","loadstate"}` (the agent is acting on a page it's driving); for `for === "response"` do NOT claim — it's purely observational, and silently overlaying a tab the agent isn't touching violates the human-in-the-loop contract. Add `"page_wait"` to `BATCHABLE_TOOLS`, to `registry`, and to the returned tools map. Description must lead with uid mode, spell out all five modes, the "selector/function = main frame only" caveat, and the "response mode is observational, doesn't claim" note.

- [ ] **Step 9: MCP wrapper unit test** — uid mode asserts `["session.claim","page.wait"]`; response mode asserts `["page.wait"]` only (no claim).

- [ ] **Step 10: Integration test** — `page-wait.integration.test.ts`: navigate a fixture page that injects `#late` after 800ms via `setTimeout`; snapshot, then `page_wait({for:"uid",uid:<the late node>})` — OR if uid isn't available pre-injection, `page_wait({for:"selector",selector:"#late"})` resolves; a `page_wait` for a nonexistent selector with `timeoutMs:500` rejects.

- [ ] **Step 11: README + commit** — add `page_wait` under a new **Wait** group, bump the count. Commit per-task.

---

## Task 2: Actionability helper (shared, internal — no new tool)

**The gap:** a human won't click a button that's still spinning in, mid-animation, or disabled — they wait the half-second until it's real. Chromanche acts immediately, so a uid from a stale snapshot fails hard. (Playwright bakes this in as "actionability"; we want the same human-grade behaviour.)

**Design:** A reusable `waitForActionable(mgr, tabId, el, opts)` helper in `page-interact.ts` that polls (≤ `timeoutMs`, default 5000) for: element connected to DOM, non-zero box, `visibility !== hidden`, `display !== none`, not `disabled`/`aria-disabled`, and box position stable across two consecutive frames (catches mid-animation). Runs via `Runtime.callFunctionOn` on the resolved `objectId` in the element's own session (works for OOPIFs — Excel/Office addin frames). Returns `{ actionable: boolean, reason?: string }`.

**Files:**
- Modify `packages/extension/src/handlers/page-interact.ts` — add the helper (do not wire it into handlers yet; that's Task 3).
- Modify `packages/extension/test/handlers.unit.test.ts` — unit test the helper via an exported test seam OR via a click on a hidden-then-shown element.

- [ ] **Step 1: Failing test** — assert that clicking an element reported as `display:none` by the fake debugger surfaces a "not actionable" reason once Task 3 wires it; for Task 2 alone, export `waitForActionable` and unit-test it directly: hidden → `{actionable:false, reason:"hidden"}`, visible+stable → `{actionable:true}`.

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Implement** `waitForActionable`. The in-page predicate (string passed to `Runtime.callFunctionOn`, `this` = element):
```js
function() {
  if (!this.isConnected) return { ok:false, reason:"detached" };
  const r = this.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return { ok:false, reason:"zero-size" };
  const cs = getComputedStyle(this);
  if (cs.visibility === "hidden" || cs.display === "none") return { ok:false, reason:"hidden" };
  if (this.disabled || this.getAttribute("aria-disabled") === "true") return { ok:false, reason:"disabled" };
  return { ok:true, x:r.x, y:r.y };
}
```
Poll twice 60ms apart; require the same `x,y` (±1px) for stability. Cap at `timeoutMs`.

- [ ] **Step 4: Run, confirm pass.**

- [ ] **Step 5: Commit** — `feat(extension): waitForActionable helper (visibility/stability/enabled gate)`.

---

## Task 3: Bake auto-wait into `page.click` and `page.type`

**Design:** Both handlers call `waitForActionable` after `resolveElement` and before dispatching. Add an opt-out `force: boolean = false` field (Playwright parity — skip the gate when the model knows better). On non-actionable, throw a structured error including the `reason` so the model can `page_wait` or re-snapshot. Keep the existing focus-escalation ladder for `page.type` untouched — actionability runs *first*.

**Files:**
- Modify `packages/shared/src/protocol.ts` — add `force: z.boolean().default(false)` to `PageClickParamsSchema` and `PageTypeParamsSchema`.
- Modify `packages/shared/test/protocol.test.ts` — assert `force` defaults false and round-trips.
- Modify `packages/extension/src/handlers/page-interact.ts` — gate both handlers on `waitForActionable` unless `force`.
- Modify `packages/extension/test/handlers.unit.test.ts` — click on hidden element throws with reason; `force:true` bypasses.
- Modify `packages/mcp-server/src/tools.ts` — surface `force` in click/type descriptions (no schema change needed beyond shared).
- Create/extend `packages/mcp-server/test/page-batch.integration.test.ts` or a new `actionability.integration.test.ts` — click a button revealed after a delay succeeds without a manual sleep.

- [ ] **Step 1: Failing schema test** for `force` default. Run shared unit. Implement. Run.
- [ ] **Step 2: Failing handler test** — hidden element click throws `not actionable: hidden`; `force:true` proceeds. Run, confirm fail.
- [ ] **Step 3: Implement** the gate in `page.click` and `page.type` (no-target typing path stays as-is — there's no element to gate). Run, confirm pass.
- [ ] **Step 4: Integration test** — confirm real click on a delayed-reveal button works. Run.
- [ ] **Step 5: README note + commit** — mention auto-wait + `force` opt-out.

---

## Task 4: `page_wait_for_download` — capture file downloads

**The gap:** No download capture. When the agent exports an Excel sheet or a Power Automate run history, it has no way to know the file landed or where. Playwright's `download` event has no equivalent here.

**Design — the Chromanche way:** the file is the *user's* download, landing wherever the *user's* Chrome already puts it. We do NOT use CDP `Page.setDownloadBehavior` to redirect it to a sandbox dir — that would reconfigure the real browser's behaviour behind the user's back, exactly what Chromanche refuses to do. Instead `page_wait_for_download` is **observational**: it arms `chrome.downloads.onCreated` + `onChanged` listeners, the model fires the export click itself, and the tool resolves with the metadata of the *next* download that completes (filename, the path Chrome chose, bytes, mime). Respect `timeoutMs`. **Least exposure:** record `armedAt` and only ever report downloads created after the wait was armed — never call `chrome.downloads.search` to enumerate the user's history. Add a code comment citing CLAUDE.md's data-residency principle. **Claim discipline:** this tool is observational; it does not need to claim a tab (the preceding export click already did).

**Files:**
- Modify `packages/extension/manifest.json` — add `"downloads"` to `permissions` (the ONLY new permission in this whole plan). It's a `chrome.*`/manifest change, so per CLAUDE.md it MUST have an integration test.
- Modify `packages/shared/src/protocol.ts` — `PageWaitForDownloadParamsSchema` ({ timeoutMs, filenamePattern? }) + result ({ ok, filename, path, bytes, mime, finalUrl }).
- Modify `packages/shared/test/protocol.test.ts` — round-trip + validation.
- Create `packages/extension/src/handlers/downloads.ts` — handler using `chrome.downloads` (observational, post-`armedAt` only).
- Modify `packages/extension/src/handlers/index.ts` — register it.
- Modify `packages/extension/test/handlers.unit.test.ts` — unit test with a fake `chrome.downloads` that emits onCreated→onChanged(complete); assert resolved path; assert timeout when nothing fires; assert it ignores a download whose `startTime`/id predates `armedAt`.
- Modify `packages/mcp-server/src/tools.ts` — `page_wait_for_download` wrapper. Observational → does NOT `ensureClaim`. NOT in `BATCHABLE_TOOLS` initially (it's a long-lived wait; revisit).
- Modify `packages/mcp-server/test/tools.unit.test.ts` — wrapper test asserting no `session.claim` is issued.
- Create `packages/mcp-server/test/download.integration.test.ts` — click a link to a small fixture file, assert the tool returns the real path Chrome chose (read the test profile's default download dir from the Playwright persistent context). Do NOT assert a redirected/sandboxed path — we don't redirect.
- Modify `README.md` — document under a **Download** group, note the new `downloads` permission, and that it reports the user's real download (no redirection).

- [ ] **Step 1:** Failing schema test → add schema → pass.
- [ ] **Step 2:** Add `"downloads"` to manifest permissions.
- [ ] **Step 3:** Failing handler unit test (fake `chrome.downloads`) → implement `downloads.ts` → pass. The handler: record `armedAt = Date.now()`, arm `onCreated`/`onChanged` listeners, resolve on the first `onChanged` with `state:"complete"` whose download was *created after `armedAt`* (track ids seen via `onCreated`), filter by `filenamePattern` regex if given. Do NOT call `chrome.downloads.search` to baseline or enumerate history — only react to live events after arming.
- [ ] **Step 4:** Register in `index.ts`.
- [ ] **Step 5:** MCP wrapper + unit test (asserts no `session.claim`).
- [ ] **Step 6:** Integration test against headed Chromium; click a fixture download link and assert the returned path is the one Chrome chose and the file exists. This also covers the manifest permission change per CLAUDE.md.
- [ ] **Step 7:** README + commit.

> Spirit guardrail to honor: it's the user's download, in the user's download folder — we observe, we don't redirect, and we never enumerate history. Only report downloads created after the wait is armed. Add a code comment citing CLAUDE.md's data-residency principle.

---

## Task 5: `page_scroll` wheel mode (virtualized grids)

**The gap:** `page.scroll` uses JS `scrollIntoView`/`scrollTo`/`scrollBy` (`page-interact.ts:266-286`). Excel's canvas grid and other virtualized lists lazy-load rows on real wheel events, which JS scroll may not trigger.

**Design:** Add `mode: "js" | "wheel"` to `PageScrollParamsSchema` (default `"js"`, preserving current behaviour exactly). `wheel` mode dispatches `Input.dispatchMouseEvent` with `type:"mouseWheel"`, `deltaX/deltaY` from `dx/dy`, anchored at a `uid`'s center when given (preferred — resolve via the existing `resolveElement`/`getElementCenter` path, OOPIF-aware), else a `selector`'s center (fallback), else the viewport center. This drives the real wheel pipeline virtualized grids (Excel's canvas) listen to.

**Files:**
- Modify `packages/shared/src/protocol.ts` — add `mode` to `PageScrollParamsSchema`; relax the "exactly one of dx/dy|selector|to" refine so `wheel` mode allows `dx/dy` with an optional anchor `selector`.
- Modify `packages/shared/test/protocol.test.ts` — wheel mode round-trips; default mode is `js`.
- Modify `packages/extension/src/handlers/page-interact.ts` — branch `page.scroll` on `mode`.
- Modify `packages/extension/test/handlers.unit.test.ts` — wheel mode dispatches `mouseWheel` with correct deltas.
- Modify `packages/mcp-server/src/tools.ts` — update `page_scroll` description (no new tool).
- Modify an existing scroll integration test (or add one) — wheel-scroll a tall fixture and assert `window.scrollY` advanced.
- Modify `README.md`.

- [ ] Steps mirror the standard ladder: failing schema test → schema → pass → failing handler test → implement → pass → integration → README → commit. Keep `mode:"js"` byte-identical to today's path so no regression.

---

## Task 6: Keyboard modifiers in `page_type`

**The gap:** `page.type` dispatches char-by-char with `modifiers` hardcoded to `0` (`page-interact.ts:682,750`). No chord typing (e.g. Ctrl+Shift+ArrowRight range selection in Excel) except via separate `page_press_key` calls — which races focus across calls.

**Design:** Add optional `modifiers: ("Alt"|"Control"|"Meta"|"Shift")[]` to `PageTypeParamsSchema`. When set, apply `modifierFlags(modifiers)` to every dispatched key in that call. Document it as "applies to the whole text run — use for chords, not for typing mixed-case (Shift is implicit in char case)." This keeps the common path (no modifiers) unchanged.

**Files:**
- Modify `packages/shared/src/protocol.ts` — add `modifiers` to `PageTypeParamsSchema`.
- Modify `packages/shared/test/protocol.test.ts` — default `[]`, round-trips.
- Modify `packages/extension/src/handlers/page-interact.ts` — thread `modifierFlags(p.modifiers)` into both `dispatchKey` loops (no-target path + element path).
- Modify `packages/extension/test/handlers.unit.test.ts` — `page.type` with `modifiers:["Control"]` sets the modifier flag on dispatched keys.
- Modify `packages/mcp-server/src/tools.ts` — extend `page_type` description.
- Modify `README.md` if the description materially changes.

- [ ] Standard ladder. Commit.

---

## Cross-cutting: post-implementation verification

- [ ] `pnpm -r test:unit` — all green.
- [ ] `pnpm -r test:integration` — all green (headed Chromium with packaged extension).
- [ ] `pnpm -r build` — clean.
- [ ] Re-verify guardrails: `lsof -iTCP -sTCP:ESTABLISHED -p <mcp-pid>` shows loopback only; no new outbound deps introduced; WS still token-gated; new `downloads` permission is the ONLY new manifest permission.
- [ ] Update `README.md` tool count and groups once, coherently, after all tools land (Wait, Download added; Interact/Scroll/Type notes updated).
- [ ] **Do NOT** bump `manifest.json` version, tag, or release. Stop after code + tests + build + docs.

---

## Explicitly out of scope (and why) — these would betray the Chromanche spirit

- **Request interception / route-mocking** — would mean intercepting and rewriting traffic on the user's real, logged-in session (Gmail, banking, internal tools). That's the opposite of "you can see exactly what the agent is doing"; `network_read` (observational) + `page_fetch` (same-origin, same-cookies) cover the legitimate needs.
- **Storage-state import/export & cookie get/set** — the live session IS the state. Importing fabricated cookies/storage turns Chromanche into a credential-injection tool and undermines its reason to exist (drive the browser the human already trusts).
- **Emulation (viewport/geo/timezone/device)** — the real browser's real environment is the point. Faking it is a headless-testing concern, not a "drive my actual Chrome" one.
- **`Page.setDownloadBehavior` / sandboxed download dirs** — reconfigures the user's browser behind their back. We observe the real download instead (Task 4).
- **Trace/video artifacts** — a GIF-record plan already exists separately; Playwright-grade tracing is disproportionate for this gap.
- **Cross-frame drag, popup-as-page objects** — real but lower-frequency for Forms/Excel/Power Automate; defer to a later plan if usage demands.

## Self-review

1. **Spec coverage:** Tasks map 1:1 to the gaps (paste→Task 0, wait→1, auto-wait→2+3, download→4, wheel-scroll→5, chords→6). ✓
2. **Chromanche spirit upheld:** every primitive is uid/a11y-first with selector as fallback; observational tools (`page_wait` response mode, `page_wait_for_download`) never claim/overlay a tab they aren't acting on; downloads are observed in the user's real folder, never redirected, never enumerated; no transport/auth/telemetry change; only one new permission (`downloads`). We borrow Playwright's *capabilities* without adopting its *throwaway-controlled-browser* posture. ✓
3. **Test discipline:** every task carries shared schema round-trip + extension unit + (for `chrome.*`/manifest/wire changes) an integration test, per CLAUDE.md. ✓
4. **No protocol drift:** every new wire method (`page.wait`, `page.waitForDownload`) and every param addition lands in `packages/shared` first, consumed by both sides. ✓
5. **No premature release:** verification step forbids versioning/tagging. ✓
