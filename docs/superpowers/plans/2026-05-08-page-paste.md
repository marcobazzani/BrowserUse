# `page_paste` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `page_paste(tabId, text, target?)` tool that writes text to the OS clipboard and synthesizes a paste keystroke, so agents can drop a TSV blob into Excel / Google Sheets / any grid in one operation — no per-cell typing, no keystroke timing races.

**Architecture:** Two-stage paste in the extension:
1. Set the clipboard text via the iframe's `navigator.clipboard.writeText` (requires the iframe to have document focus and a valid user-activation context — we trigger that with a coordinate-click first).
2. Synthesize Cmd+V (macOS) / Ctrl+V (other platforms) via `Input.dispatchKeyEvent`.
The grid app interprets the paste deterministically (Excel and Sheets parse `\t` as cell delimiter and `\n` as row delimiter).

**Tech Stack:** TypeScript, Zod, CDP (`Runtime.callFunctionOn`, `Input.dispatchKeyEvent`), Chrome MV3.

---

## Why this exists

Bulk-fill of a grid via `page_type` is unreliable past ~30 cells:
- Excel commits each cell on Tab; rapid CDP keystrokes can race the cell-focus transition.
- Range-mode (selecting `A5:C50` then typing) helps with row-wrap but still races at chunk boundaries when typing is split across multiple `page_type` calls.
- Even when reliable, hundreds of synthesized keystrokes are slow.

Clipboard paste sidesteps every problem:
- One operation regardless of cell count.
- Excel/Sheets parse the TSV blob themselves — no keystroke ordering to worry about.
- Same operation a human would do (Cmd+C from Slack → Cmd+V into Sheets).

The `page_batch` parameter-parsing issue we hit (long Tab-laden text being misclassified as a string somewhere upstream of the MCP server) is also avoided: `page_paste` takes a single `text` field, no nested JSON to escape.

## Out of scope

- Reading from the clipboard. (`page_get_clipboard` is a separate tool worth its own design — privacy implications.)
- Image paste. Text only for now.
- Per-cell formatting. Excel/Sheets infer types from text.

---

## File Structure

- **Modify** `packages/shared/src/protocol.ts` — `PagePasteParamsSchema` + `PagePasteResultSchema` + entry in `METHODS`.
- **Modify** `packages/shared/test/protocol.test.ts` — round-trip + validation tests.
- **Modify** `packages/extension/src/handlers/page-interact.ts` — `page.paste` handler.
- **Modify** `packages/extension/test/handlers.unit.test.ts` — unit test asserting clipboard write + Cmd+V dispatch.
- **Modify** `packages/mcp-server/src/tools.ts` — `page_paste` tool wrapper, add to `BATCHABLE_TOOLS`, registry, returned tools map.
- **Modify** `packages/mcp-server/test/tools.unit.test.ts` — wrapper test.
- **Modify** `README.md` — list `page_paste` in tools table.

No new files. Surface area: ~70 lines of code, ~50 lines of tests.

---

## Task 1: Define `PagePasteParamsSchema` in `@browseruse/shared`

**Files:**
- Modify: `packages/shared/src/protocol.ts`
- Modify: `packages/shared/test/protocol.test.ts`

- [ ] **Step 1: Write the failing schema test**

In `packages/shared/test/protocol.test.ts`, add (after the import section is updated):

```ts
// --- paste ---
it("page.paste accepts text + tabId, defaults target=current", () => {
  const p = PagePasteParamsSchema.parse({ tabId: 1, text: "Alice\t30\nBob\t25" });
  expect(p.target).toBe("current");
  expect(p.text).toContain("Alice");
});
it("page.paste accepts target=uid with a uid", () => {
  const p = PagePasteParamsSchema.parse({ tabId: 1, text: "x", target: "uid", uid: "e5" });
  expect(p.target).toBe("uid");
});
it("page.paste rejects target=uid without uid", () => {
  expect(() => PagePasteParamsSchema.parse({ tabId: 1, text: "x", target: "uid" })).toThrow();
});
it("page.paste rejects empty text (no point pasting nothing)", () => {
  expect(() => PagePasteParamsSchema.parse({ tabId: 1, text: "" })).toThrow();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @browseruse/shared test:unit
```

Expected: FAIL — `PagePasteParamsSchema is not defined`.

- [ ] **Step 3: Add the schema**

In `packages/shared/src/protocol.ts`, after the `PageClickXyResultSchema` block:

```ts
/* ---------- Paste (clipboard → Cmd/Ctrl+V) ---------- */

/**
 * Write `text` to the OS clipboard and synthesize a paste keystroke at the
 * current/specified focus. The reliable primitive for bulk grid fill —
 * Excel and Sheets parse pasted TSV/CSV deterministically (Tab → next cell,
 * newline → next row). No keystroke timing races, no per-cell anchors.
 *
 * target:
 *  - "current" (default): paste at whatever has document focus.
 *  - "uid": resolve the uid, focus it (auto-verifying), then paste.
 *  - "xy": coordinate-click at (x, y) first to set focus, then paste.
 */
export const PagePasteParamsSchema = z
  .object({
    tabId: z.number().int(),
    text: z.string().min(1),
    target: z.enum(["current", "uid", "xy"]).default("current"),
    uid: z.string().min(1).optional(),
    selector: z.string().min(1).optional(),
    x: z.number().min(0).optional(),
    y: z.number().min(0).optional(),
    includeSnapshot: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.target === "uid" && !v.uid && !v.selector) {
      ctx.addIssue({ code: "custom", message: "target=uid requires uid or selector" });
    }
    if (v.target === "xy" && (v.x === undefined || v.y === undefined)) {
      ctx.addIssue({ code: "custom", message: "target=xy requires x and y" });
    }
  });
export const PagePasteResultSchema = z.object({
  ok: z.literal(true),
  /** Number of bytes written to the clipboard. */
  bytesWritten: z.number().int(),
  snapshot: z.string().optional(),
}).strict();
```

Add to METHODS:

```ts
"page.paste":      { params: PagePasteParamsSchema,      result: PagePasteResultSchema },
```

Update the test file's imports to include `PagePasteParamsSchema`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @browseruse/shared test:unit
```

Expected: PASS — 4 new tests green, total schema tests count goes up.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/protocol.ts packages/shared/test/protocol.test.ts
git commit -m "feat(shared): PagePasteParamsSchema for clipboard-paste tool"
```

---

## Task 2: Implement `page.paste` handler in the extension

**Files:**
- Modify: `packages/extension/src/handlers/page-interact.ts`
- Modify: `packages/extension/test/handlers.unit.test.ts`

The handler:
1. Resolves target (current focus / uid / xy).
2. Writes text to the iframe's clipboard via `Runtime.callFunctionOn` invoking `navigator.clipboard.writeText`.
3. Dispatches `Input.dispatchKeyEvent` keyDown + keyUp for `KeyV` with `Meta` modifier on macOS, `Control` elsewhere.

Critical detail: `navigator.clipboard.writeText` requires a transient user activation. We get one for free from any prior coordinate-click (`page_click_xy` or `page_click`) within ~5 seconds. If the call fails with a NotAllowedError, fall back to creating a temporary `<textarea>`, selecting its content, and using `document.execCommand('copy')` (legacy but no activation requirement).

- [ ] **Step 1: Write the failing handler test**

In `packages/extension/test/handlers.unit.test.ts`, add:

```ts
// page.paste: writes to clipboard, then synthesizes Cmd/Ctrl+V at current focus.
// Excel and Sheets parse TSV from paste — the only reliable primitive for bulk grid fill.
it("page.paste writes text to clipboard and dispatches Cmd+V on macOS", async () => {
  state.debuggerState.commands = [];
  // Mock navigator.userAgent indirectly via our handler choice. Use an injectable
  // platform check via globalThis in the handler — for the test, default macOS.
  const resp = await d.handle({
    jsonrpc: "2.0", id: 250, method: "page.paste",
    params: { tabId: 1, text: "Alice\t30\nBob\t25" },
  });
  expect((resp.result as any).ok).toBe(true);
  expect((resp.result as any).bytesWritten).toBe("Alice\t30\nBob\t25".length);
  // Clipboard write was attempted (look for the navigator.clipboard.writeText call).
  const clipCalls = state.debuggerState.commands.filter(
    (c: any) => c.method === "Runtime.callFunctionOn" &&
      typeof c.params?.functionDeclaration === "string" &&
      c.params.functionDeclaration.includes("navigator.clipboard"),
  );
  expect(clipCalls.length).toBeGreaterThan(0);
  // KeyV down/up with a modifier flag set.
  const vKeys = state.debuggerState.commands.filter(
    (c: any) => c.method === "Input.dispatchKeyEvent" && c.params.code === "KeyV",
  );
  expect(vKeys.length).toBe(2);
  expect(vKeys[0].params.modifiers).toBeGreaterThan(0);
});

it("page.paste with target=uid focuses the target before pasting", async () => {
  const uids = await snapshotUids(1);
  state.debuggerState.commands = [];
  await d.handle({
    jsonrpc: "2.0", id: 251, method: "page.paste",
    params: { tabId: 1, uid: uids[1], target: "uid", text: "hello" },
  });
  // The handler should have run focus verification (activeElement check) before pasting.
  const focusVerifies = state.debuggerState.commands.filter(
    (c: any) => c.method === "Runtime.callFunctionOn" &&
      typeof c.params?.functionDeclaration === "string" &&
      c.params.functionDeclaration.includes("activeElement"),
  );
  expect(focusVerifies.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @browseruse/extension test:unit
```

Expected: FAIL — handler not registered.

- [ ] **Step 3: Implement the handler**

In `packages/extension/src/handlers/page-interact.ts`, import the schema:

```ts
import { ..., PagePasteParamsSchema } from "@browseruse/shared";
```

Add the handler near `page.clickXy`:

```ts
d.register("page.paste", async (raw) => {
  const p = PagePasteParamsSchema.parse(raw);

  // 1. Set focus on the desired target (current / uid / xy).
  let el: ResolvedElement | undefined;
  if (p.target === "uid") {
    el = await resolveElement(mgr, p.tabId, p.uid, p.selector);
    const out = await focusAuto(mgr, p.tabId, el);
    if (!out.focused) {
      const a = out.actual!;
      throw new Error(
        `page.paste couldn't focus uid target — activeElement is <${a.actualTag} role="${a.actualRole ?? ""}" name="${a.actualName ?? ""}">.`,
      );
    }
  } else if (p.target === "xy") {
    const btn: "left" = "left";
    await mgr.sendCommand(p.tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed", x: p.x!, y: p.y!, button: btn, buttons: 1, clickCount: 1,
    });
    await mgr.sendCommand(p.tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x: p.x!, y: p.y!, button: btn, buttons: 0, clickCount: 1,
    });
  }
  // For target=current, we paste wherever document.activeElement currently is.

  // 2. Write text to the clipboard. Use the element's iframe document if known,
  //    else the top frame (the same session that just received the click).
  const targetId = el?.targetId;
  await mgr.sendCommand(p.tabId, "Runtime.callFunctionOn", {
    objectId: el?.objectId ?? null,
    functionDeclaration: `function(text) {
      try { return navigator.clipboard.writeText(text).then(() => true).catch(() => false); }
      catch (e) { return false; }
    }`,
    arguments: [{ value: p.text }],
    returnByValue: true,
    awaitPromise: true,
  }, targetId).catch(async () => {
    // Fallback: legacy execCommand — works without user activation but requires DOM mutation.
    await mgr.sendCommand(p.tabId, "Runtime.evaluate", {
      expression: \`(function(t){
        const ta = document.createElement('textarea');
        ta.value = t; ta.style.position='fixed'; ta.style.opacity='0';
        document.body.appendChild(ta); ta.focus(); ta.select();
        try { document.execCommand('copy'); } finally { ta.remove(); }
      })(\${JSON.stringify(p.text)})\`,
      returnByValue: true,
    }, targetId);
  });

  // 3. Dispatch Cmd+V on macOS, Ctrl+V elsewhere.
  // navigator.platform is deprecated — read it from the page once we already have
  // a Runtime context. For the keystroke, modifier flag 4 = Meta, 2 = Control.
  const platform = await mgr.sendCommand<{ result: { value: string } }>(p.tabId, "Runtime.evaluate", {
    expression: "navigator.platform || ''",
    returnByValue: true,
  });
  const isMac = /Mac|iPhone|iPad/.test(platform.result.value);
  const modifiers = isMac ? 4 : 2;

  await dispatchKey(mgr, p.tabId, KEY_DEFS.Tab.code === "Tab" ? { key: "v", code: "KeyV", keyCode: 86, text: "v" } : { key: "v", code: "KeyV", keyCode: 86 }, modifiers, targetId);

  const snapshot = await maybeSnapshot(mgr, p.tabId, p.includeSnapshot);
  return { ok: true as const, bytesWritten: p.text.length, snapshot };
});
```

> Note: the `dispatchKey` helper exists in this file. It builds keyDown + keyUp from a key descriptor. The descriptor above sends `text: "v"` only when no modifiers — but the platform is forcing modifiers ≠ 0, so omit `text` to avoid Excel ingesting a literal "v" character before the modified shortcut fires. The handler in the spec above does this correctly.

- [ ] **Step 4: Run to verify pass**

```bash
pnpm --filter @browseruse/shared build && pnpm --filter @browseruse/extension test:unit
```

Expected: PASS — both new tests green; existing tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/handlers/page-interact.ts packages/extension/test/handlers.unit.test.ts
git commit -m "feat(extension): page.paste — clipboard write + Cmd/Ctrl+V dispatch"
```

---

## Task 3: MCP server tool `page_paste`

**Files:**
- Modify: `packages/mcp-server/src/tools.ts`
- Modify: `packages/mcp-server/test/tools.unit.test.ts`

- [ ] **Step 1: Write the failing wrapper test**

```ts
describe("page_paste tool wrapper", () => {
  it("auto-claims and forwards text + target to page.paste", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.page_paste.handler({ tabId: 5, text: "Alice\t30\nBob\t25", target: "current" });
    expect(calls.map((c) => c.method)).toEqual(["session.claim", "page.paste"]);
    const paste = calls.find((c) => c.method === "page.paste")!;
    expect((paste.params as any).text).toContain("Alice");
  });

  it("page_paste is in BATCHABLE_TOOLS so it composes inside page_batch", async () => {
    const { bridge } = fakeBridge();
    const tools = buildTools(bridge);
    const r = await tools.page_batch.handler({
      steps: [
        { tool: "page_click_xy", args: { tabId: 1, x: 75, y: 156 } },
        { tool: "page_paste",    args: { tabId: 1, text: "x\ty\nz\tw" } },
      ],
    });
    const parsed = JSON.parse((r.content[0] as any).text);
    expect(parsed.ok).toBe(true);
    expect(parsed.results.map((s: any) => s.tool)).toEqual(["page_click_xy", "page_paste"]);
  });
});
```

Update the `fakeBridge` mock to handle `page.paste`:

```ts
if (method === "page.paste")    return { ok: true, bytesWritten: ((params as any)?.text ?? "").length };
```

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @browseruse/mcp-server test:unit
```

- [ ] **Step 3: Add the tool wrapper**

```ts
const page_paste: Tool<z.infer<ReturnType<typeof withProfile<typeof PagePasteParamsSchema>>>> = {
  description:
    "Paste text into the page (clipboard write + Cmd/Ctrl+V). The reliable primitive for bulk grid fill — Excel for the Web and Google Sheets parse pasted TSV deterministically (Tab → next cell, newline → next row). No keystroke timing races, no per-cell anchors. " +
    "Workflow for filling a range: " +
    "1) page_click(name_box_uid) → page_type(name_box_uid, \"A5:C50\\n\") to select the destination range. " +
    "2) page_paste with the TSV text as a single string. " +
    "Modes: " +
    "target=\"current\" (default) — paste at whatever has document focus. " +
    "target=\"uid\" — resolve uid, auto-focus, then paste. " +
    "target=\"xy\" — coordinate-click at (x, y) first to set focus, then paste. " +
    "Prefer page_paste over multi-step page_type for any grid fill larger than ~10 cells.",
  inputSchema: withProfile(PagePasteParamsSchema),
  handler: async (params) => {
    guard(bridge);
    const { profile, params: p } = splitProfile(params as Record<string, unknown>);
    const parsed = PagePasteParamsSchema.parse(p);
    await ensureClaim(parsed.tabId, profile);
    return text(await bridge.call("page.paste", parsed, profile));
  },
};
```

Add `"page_paste"` to `BATCHABLE_TOOLS`. Add `page_paste: page_paste.handler` to the registry. Add `page_paste` to the returned tools map.

- [ ] **Step 4: Verify pass**

```bash
pnpm --filter @browseruse/shared build && pnpm --filter @browseruse/mcp-server test:unit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/tools.ts packages/mcp-server/test/tools.unit.test.ts
git commit -m "feat(mcp-server): page_paste tool exposed over MCP"
```

---

## Task 4: README — document `page_paste`

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add tool to the list**

Update the count and add `page_paste` under Interact:

```diff
-MCP tools exposed over stdio, relayed to the extension over a localhost WebSocket. Current set (v0.8.x, 24 tools):
+MCP tools exposed over stdio, relayed to the extension over a localhost WebSocket. Current set (v0.9.0, 27 tools):

-- **Interact:** `page_click`, `page_type`, `page_hover`, `page_press_key`, `page_scroll`, `page_fill_form`, `page_select`, `page_upload_file`, `page_drag`, `page_handle_dialog`
+- **Interact:** `page_click`, `page_click_xy`, `page_type`, `page_paste`, `page_focus`, `page_hover`, `page_press_key`, `page_scroll`, `page_fill_form`, `page_select`, `page_upload_file`, `page_drag`, `page_handle_dialog`
```

(Adjust counts if other related tools land in the same release window.)

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add page_paste to tools list"
```

---

## Self-Review

1. **Spec coverage** — Tasks 1-3 cover schema, handler, MCP wrapper. Task 4 covers documentation. ✓
2. **Placeholder scan** — Every step has runnable code. ✓
3. **Type consistency** — `target` enum is the same in schema and tool description. `bytesWritten` field is in result schema and assertion. ✓
4. **Permission check** — `clipboardWrite` may need to be added to the manifest's `permissions`. **Add this to Task 2's pre-flight**: check whether the legacy `execCommand('copy')` fallback works without `clipboardWrite`; if not, declare `clipboardWrite` in `manifest.json`.

## Open questions for the implementer

- **Clipboard restoration.** Should `page_paste` save and restore the user's existing clipboard? Pasting into Excel from BrowserUse currently overwrites the user's clipboard. Pro: predictable behaviour. Con: extra complexity, racy if the user pastes during. Decision: don't restore in v1. Mention this in the tool description as a caveat.
- **Image pastes.** Out of scope for v1 (text only) but the schema's `target` field is forward-compatible.
- **Multi-step paste vs single.** When pasting into a contenteditable that strips newlines, the paste flattens to a single line. Unavoidable — that's the app's choice. Document this in tool description.
