# `page_batch` MCP tool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single `page_batch` MCP tool that runs multiple BrowserUse tool calls sequentially in one MCP round-trip, so an agent can perform a multi-step interaction (click → type → screenshot) without paying N model-loop latencies.

**Architecture:** Pure **server-side** orchestration. `page_batch` lives entirely in `packages/mcp-server` — it dispatches each step to the existing in-process tool handlers via a registry lookup, returns an array of per-step results, and stops on first error (default) or continues (opt-in). No new wire method, no extension change, no shared-protocol bump. The dominant cost we are eliminating is the LLM tool round-trip; the per-step WS hop to the extension over loopback is sub-millisecond and not worth optimising.

This deliberately mirrors Claude in Chrome's `browser_batch` shape so prompts can carry over with minimal adaptation.

**Tech Stack:** TypeScript, Zod, Vitest, MCP SDK, Playwright (for the integration test).

---

## File Structure

- **Modify** `packages/mcp-server/src/tools.ts` — add the `page_batch` tool and a tool-name → handler registry.
- **Modify** `packages/mcp-server/test/tools.unit.test.ts` — unit tests for the orchestrator behaviour.
- **Create** `packages/mcp-server/test/page-batch.integration.test.ts` — end-to-end test that batches `page_click + page_type + page_screenshot` against a headed Chromium with the packaged extension.
- **Modify** `README.md` — list `page_batch` in the tools table with a one-line example.

No `packages/shared/src/protocol.ts` change. No `packages/extension/**` change.

---

## Task 1: Define the `page_batch` Zod schema (server-local)

**Files:**
- Modify: `packages/mcp-server/src/tools.ts` (add schema near the top, before `buildTools`)

- [ ] **Step 1: Write the failing schema round-trip unit test**

In `packages/mcp-server/test/tools.unit.test.ts`, add at the top of the file imports:

```ts
import { PageBatchParamsSchema } from "../src/tools.js";
```

Then add a new `describe` block:

```ts
describe("PageBatchParamsSchema", () => {
  it("round-trips a 3-step batch with default stopOnError", () => {
    const input = {
      steps: [
        { tool: "page_click", args: { tabId: 1, uid: "e5" } },
        { tool: "page_type",  args: { tabId: 1, uid: "e6", text: "hi" } },
        { tool: "page_screenshot", args: { tabId: 1 } },
      ],
    };
    const parsed = PageBatchParamsSchema.parse(input);
    expect(parsed.stopOnError).toBe(true);   // default
    expect(parsed.steps).toHaveLength(3);
    expect(parsed.steps[0].tool).toBe("page_click");
  });

  it("rejects an empty steps array", () => {
    expect(() => PageBatchParamsSchema.parse({ steps: [] })).toThrow();
  });

  it("rejects unknown tool names", () => {
    expect(() => PageBatchParamsSchema.parse({
      steps: [{ tool: "page_nope", args: {} }],
    })).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @browseruse/mcp-server test:unit
```

Expected: FAIL with `PageBatchParamsSchema is not exported from "../src/tools.js"`.

- [ ] **Step 3: Add the schema and export it**

In `packages/mcp-server/src/tools.ts`, near the top (after the imports, before `buildTools`):

```ts
/**
 * Names of every batchable tool. Kept as a literal union so the model sees
 * an enum in the JSON schema and can't ask for nonexistent tools.
 *
 * page_batch is intentionally not in this list — no batches inside batches.
 */
export const BATCHABLE_TOOLS = [
  "tabs_list", "tabs_create", "tabs_close", "tabs_activate",
  "page_navigate", "page_snapshot", "page_screenshot",
  "page_click", "page_type", "page_scroll",
  "page_hover", "page_press_key", "page_fill_form",
  "page_handle_dialog", "page_select", "page_upload_file", "page_drag",
  "page_fetch", "page_eval_js",
  "console_read", "network_read",
  "session_release",
] as const;

export const PageBatchStepSchema = z.object({
  tool: z.enum(BATCHABLE_TOOLS),
  args: z.record(z.unknown()),
}).strict();

export const PageBatchParamsSchema = z.object({
  steps: z.array(PageBatchStepSchema).min(1).max(32),
  /**
   * If true (default), the first failing step aborts the batch and returns
   * what ran. If false, every step runs and per-step errors are surfaced
   * inline in the results array.
   */
  stopOnError: z.boolean().default(true),
}).strict();
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @browseruse/mcp-server test:unit
```

Expected: PASS — three new tests added to `tools.unit.test.ts`, total green.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/tools.ts packages/mcp-server/test/tools.unit.test.ts
git commit -m "feat(mcp-server): add PageBatchParamsSchema for page_batch"
```

---

## Task 2: Wire `page_batch` into `buildTools` with a name → handler registry

**Files:**
- Modify: `packages/mcp-server/src/tools.ts:~360` (the `return { ... }` map at the end of `buildTools`)
- Modify: `packages/mcp-server/test/tools.unit.test.ts`

- [ ] **Step 1: Write the failing handler test (happy path, stopOnError=true)**

Append to `packages/mcp-server/test/tools.unit.test.ts`:

```ts
describe("page_batch", () => {
  it("runs steps sequentially and returns per-step results", async () => {
    const { tools, calls } = makeTools();   // existing helper used elsewhere in the file
    // makeTools returns the bridge call log in `calls`. The mocked bridge
    // returns { ok: true, echo: <method> } for every call.

    const r = await tools.page_batch.handler({
      steps: [
        { tool: "page_click", args: { tabId: 1, uid: "e5" } },
        { tool: "page_type",  args: { tabId: 1, uid: "e6", text: "hi" } },
      ],
    });

    const parsed = JSON.parse(r.content[0].text) as {
      ok: boolean;
      results: Array<{ tool: string; ok: boolean; result?: unknown; error?: string }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results[0].tool).toBe("page_click");
    expect(parsed.results[0].ok).toBe(true);
    expect(parsed.results[1].tool).toBe("page_type");
    expect(parsed.results[1].ok).toBe(true);
    // Bridge saw both forwarded methods (plus the initial session.claim).
    expect(calls.map((c) => c.method)).toContain("page.click");
    expect(calls.map((c) => c.method)).toContain("page.type");
  });

  it("aborts on first failure when stopOnError=true (default)", async () => {
    const { tools } = makeTools({
      bridgeImpl: async (method) => {
        if (method === "page.type") throw new Error("boom");
        return { ok: true, echo: method };
      },
    });
    const r = await tools.page_batch.handler({
      steps: [
        { tool: "page_click", args: { tabId: 1, uid: "e5" } },
        { tool: "page_type",  args: { tabId: 1, uid: "e6", text: "hi" } },
        { tool: "page_screenshot", args: { tabId: 1 } },
      ],
    });
    const parsed = JSON.parse(r.content[0].text) as {
      ok: boolean;
      results: Array<{ tool: string; ok: boolean; error?: string }>;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.results).toHaveLength(2);            // third step never ran
    expect(parsed.results[1].ok).toBe(false);
    expect(parsed.results[1].error).toMatch(/boom/);
  });

  it("continues past failures when stopOnError=false", async () => {
    const { tools } = makeTools({
      bridgeImpl: async (method) => {
        if (method === "page.type") throw new Error("boom");
        return { ok: true, echo: method };
      },
    });
    const r = await tools.page_batch.handler({
      stopOnError: false,
      steps: [
        { tool: "page_click", args: { tabId: 1, uid: "e5" } },
        { tool: "page_type",  args: { tabId: 1, uid: "e6", text: "hi" } },
        { tool: "page_screenshot", args: { tabId: 1 } },
      ],
    });
    const parsed = JSON.parse(r.content[0].text) as {
      ok: boolean;
      results: Array<{ tool: string; ok: boolean; error?: string }>;
    };
    expect(parsed.ok).toBe(false);                     // at least one failed
    expect(parsed.results).toHaveLength(3);            // every step ran
    expect(parsed.results.map((s) => s.ok)).toEqual([true, false, true]);
  });

  it("rejects nested page_batch via the schema", async () => {
    const { tools } = makeTools();
    await expect(tools.page_batch.handler({
      steps: [{ tool: "page_batch", args: { steps: [] } }],
    } as unknown as { steps: Array<{ tool: string; args: object }> })).rejects.toThrow();
  });
});
```

> The existing `makeTools()` helper in `tools.unit.test.ts` may need a small extension to accept an optional `bridgeImpl` override. If so, add it in this same step — it's part of building the test surface, not an additional task.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @browseruse/mcp-server test:unit
```

Expected: FAIL — `tools.page_batch is undefined`.

- [ ] **Step 3: Implement `page_batch` and the registry**

In `packages/mcp-server/src/tools.ts`, add inside `buildTools` (after every existing tool is defined, just before the `return { ... }`):

```ts
const page_batch: Tool<z.infer<ReturnType<typeof withProfile<typeof PageBatchParamsSchema>>>> = {
  description:
    "Run several BrowserUse tools sequentially in a single MCP round-trip. " +
    "Use this when you have a known sequence of actions (click → type → screenshot, " +
    "fill several fields, navigate then snapshot) — it eliminates the per-step model " +
    "loop latency. Steps run in order; by default the first failure aborts the rest. " +
    "Set stopOnError=false to run every step and collect per-step errors. " +
    "Steps share the same profile field as the batch (omit per-step). " +
    "Cannot nest page_batch inside itself.",
  inputSchema: withProfile(PageBatchParamsSchema),
  handler: async (params) => {
    guard(bridge);
    const { profile, params: p } = splitProfile(params as Record<string, unknown>);
    const parsed = PageBatchParamsSchema.parse(p);

    const results: Array<{ tool: string; ok: boolean; result?: unknown; error?: string }> = [];
    let allOk = true;
    for (const step of parsed.steps) {
      const handler = registry[step.tool];
      // Schema's z.enum guarantees registry[step.tool] exists, but guard for
      // forgotten registry entries.
      if (!handler) {
        results.push({ tool: step.tool, ok: false, error: `unknown tool: ${step.tool}` });
        allOk = false;
        if (parsed.stopOnError) break;
        continue;
      }
      try {
        // Forward the batch-level profile if the step didn't supply one.
        const stepArgs = profile && !("profile" in step.args)
          ? { ...step.args, profile }
          : step.args;
        const r = await handler(stepArgs as never);
        // Tool handlers return { content: [{ type: "text", text: <json> }] }.
        // Re-parse the inner JSON so the batch result is structured, not stringly-typed.
        const inner = r.content[0]?.text ? JSON.parse(r.content[0].text as string) : null;
        results.push({ tool: step.tool, ok: true, result: inner });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        results.push({ tool: step.tool, ok: false, error: msg });
        allOk = false;
        if (parsed.stopOnError) break;
      }
    }
    return text({ ok: allOk, results });
  },
};
```

Then construct the registry just above the `return` in `buildTools`:

```ts
const registry: Record<string, (args: never) => Promise<ToolResult>> = {
  tabs_list: tabs_list.handler,
  tabs_create: tabs_create.handler,
  tabs_close: tabs_close.handler,
  tabs_activate: tabs_activate.handler,
  page_navigate: page_navigate.handler,
  page_snapshot: page_snapshot.handler,
  page_screenshot: page_screenshot.handler,
  page_click: page_click.handler,
  page_type: page_type.handler,
  page_scroll: page_scroll.handler,
  page_hover: page_hover.handler,
  page_press_key: page_press_key.handler,
  page_fill_form: page_fill_form.handler,
  page_handle_dialog: page_handle_dialog.handler,
  page_select: page_select.handler,
  page_upload_file: page_upload_file.handler,
  page_drag: page_drag.handler,
  page_fetch: page_fetch.handler,
  page_eval_js: page_eval_js.handler,
  console_read: console_read.handler,
  network_read: network_read.handler,
  session_release: session_release.handler,
};
```

And add `page_batch` to the returned tools map:

```ts
return {
  browseruse_list_profiles,
  tabs_list, tabs_create, tabs_close, tabs_activate,
  page_navigate, page_snapshot, page_screenshot,
  page_click, page_type, page_scroll,
  page_hover, page_press_key, page_fill_form,
  page_handle_dialog, page_select, page_upload_file, page_drag,
  page_fetch, page_eval_js,
  console_read, network_read,
  session_release,
  page_batch,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @browseruse/mcp-server test:unit
```

Expected: PASS — all four `page_batch` cases plus existing tests green.

- [ ] **Step 5: Sanity-check that `page_batch` shows up in the MCP tool list**

The MCP server's stdio entrypoint exposes whatever `buildTools` returns. Add a small assertion to the existing `tools.unit.test.ts` "tool list" describe block (if present) or add this:

```ts
it("registers page_batch in the tool map", () => {
  const { tools } = makeTools();
  expect(Object.keys(tools)).toContain("page_batch");
});
```

Run again:

```bash
pnpm --filter @browseruse/mcp-server test:unit
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-server/src/tools.ts packages/mcp-server/test/tools.unit.test.ts
git commit -m "feat(mcp-server): add page_batch tool that runs steps in one round-trip"
```

---

## Task 3: End-to-end integration test (real extension, real Chromium)

**Files:**
- Create: `packages/mcp-server/test/page-batch.integration.test.ts`

This test mirrors the structure of `packages/extension/test/page-type-keystrokes.integration.test.ts` but runs from the mcp-server package against a packaged extension.

- [ ] **Step 1: Create the test file**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type BrowserContext, type Worker } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const here = dirname(fileURLToPath(import.meta.url));
const extDir = resolve(here, "../../extension/dist");
const serverEntry = resolve(here, "../dist/index.cjs");

const SHOULD_RUN = process.env.BROWSERUSE_E2E === "1";
const describeE2E = SHOULD_RUN ? describe : describe.skip;

const PORT = "59336";
const TOKEN = randomBytes(24).toString("hex");

describeE2E("page_batch end-to-end (real extension)", () => {
  let ctx: BrowserContext;
  let sw: Worker;
  let mcpClient: {
    callTool: (req: { name: string; arguments: unknown }) => Promise<{ content: Array<{ text: string }> }>;
    close: () => Promise<void>;
  };
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    if (!existsSync(extDir)) throw new Error(`extension not built: ${extDir}`);
    if (!existsSync(serverEntry)) throw new Error(`server not built: ${serverEntry}`);

    // Page with a clickable button that focuses a textarea, plus the textarea.
    // We'll click the button, then type into the now-focused textarea.
    const html = `<!doctype html><html><body>
      <button id="b" type="button">focus</button>
      <textarea id="t" rows="3" cols="40"></textarea>
      <script>
        document.getElementById('b').addEventListener('click', () => {
          document.getElementById('t').focus();
        });
      </script>
    </body></html>`;

    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    origin = `http://127.0.0.1:${port}`;

    ctx = await chromium.launchPersistentContext("", {
      headless: false,
      args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
    });
    sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
    // Authed bootstrap: write token+port into chrome.storage.local.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        await sw.evaluate(async (payload) => {
          await chrome.storage.local.set(payload);
        }, { token: TOKEN, port: Number(PORT) });
        break;
      } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    // Wait for status=authed.
    const authDeadline = Date.now() + 10_000;
    while (Date.now() < authDeadline) {
      const s = await sw.evaluate(async () => {
        const r = await chrome.storage.local.get("status");
        return r.status as string | undefined;
      }).catch(() => undefined);
      if (s === "authed") break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    const transport = new StdioClientTransport({
      command: "node",
      args: [serverEntry],
      env: { ...process.env, BROWSERUSE_PORT: PORT, BROWSERUSE_TOKEN: TOKEN },
    });
    await client.connect(transport);
    mcpClient = client as unknown as typeof mcpClient;
  }, 30_000);

  afterAll(async () => {
    await mcpClient?.close().catch(() => {});
    await ctx?.close().catch(() => {});
    await new Promise<void>((r) => server?.close(() => r()));
  });

  it("runs click + type + screenshot in one MCP call and returns three results", async () => {
    const page = await ctx.newPage();
    await page.goto(`${origin}/`);
    await page.locator("#b").waitFor({ state: "attached", timeout: 5_000 });

    const tabId = await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return tabs[0]!.id!;
    });

    const snap = await mcpClient.callTool({
      name: "page_snapshot",
      arguments: { tabId, mode: "a11y" },
    });
    const parsedSnap = JSON.parse(snap.content[0]!.text as string) as { content: string };
    const buttonUid = parsedSnap.content.match(/\[(e\d+)\][^\n]*button[^\n]*focus/)?.[1];
    const textareaUid = parsedSnap.content.match(/\[(e\d+)\][^\n]*textbox/)?.[1];
    expect(buttonUid).toBeTruthy();
    expect(textareaUid).toBeTruthy();

    const r = await mcpClient.callTool({
      name: "page_batch",
      arguments: {
        steps: [
          { tool: "page_click", args: { tabId, uid: buttonUid } },
          { tool: "page_type",  args: { tabId, uid: textareaUid, text: "Alice\t30\nBob\t25" } },
          { tool: "page_screenshot", args: { tabId, format: "jpeg", quality: 30 } },
        ],
      },
    });

    const parsed = JSON.parse(r.content[0]!.text as string) as {
      ok: boolean;
      results: Array<{ tool: string; ok: boolean }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.results.map((s) => s.tool)).toEqual(["page_click", "page_type", "page_screenshot"]);
    expect(parsed.results.every((s) => s.ok)).toBe(true);

    // The page actually received the typed content (with \t/\n expanded).
    const value = await page.locator("#t").inputValue();
    expect(value).toContain("Alice");
    expect(value).toContain("Bob");
  }, 30_000);
});
```

- [ ] **Step 2: Run the test (gated by `BROWSERUSE_E2E=1`)**

```bash
pnpm --filter @browseruse/extension build && \
pnpm --filter @browseruse/mcp-server build && \
BROWSERUSE_E2E=1 pnpm --filter @browseruse/mcp-server vitest run test/page-batch.integration.test.ts
```

Expected: PASS — single test runs in a headed Chromium, completes in <30s, leaves no orphan processes.

If it fails, the most likely causes are: (a) extension not yet built, (b) port already in use (raise PORT or randomise), (c) extension status never reaches "authed" (check service worker logs).

- [ ] **Step 3: Confirm the test is skipped without the env var (CI-friendly)**

```bash
pnpm --filter @browseruse/mcp-server vitest run test/page-batch.integration.test.ts
```

Expected: 1 test file, 1 test, 1 skipped, 0 failed.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp-server/test/page-batch.integration.test.ts
git commit -m "test(mcp-server): integration test for page_batch end-to-end"
```

---

## Task 4: README — document `page_batch` in the tools table

**Files:**
- Modify: `README.md` (the "Tools" section / table)

- [ ] **Step 1: Locate the tool list**

```bash
grep -n "page_type\|page_fill_form\|## Tools" README.md
```

The `page_batch` row should sit immediately after the existing single-action tools (`page_click`, `page_type`, …) and before `session_release`.

- [ ] **Step 2: Add the row**

Add a row of the same shape used in the README (one column for the name, one for a one-line description). Use this exact wording so the README and the MCP tool description stay in sync:

```
| `page_batch` | Run several BrowserUse tools sequentially in one MCP round-trip (click + type + screenshot, multi-step form, etc.). Aborts on first error by default; pass `stopOnError: false` to collect per-step errors. |
```

- [ ] **Step 3: Verify the README still renders**

```bash
npx markdownlint README.md || true
```

Expected: no new errors introduced (pre-existing lint warnings are not a regression).

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document page_batch in the tools table"
```

---

## Self-Review Checklist (run after the four tasks land)

1. **Spec coverage:** the original brainstorm asked for "a `page_batch` tool that takes an array of `{tool, args}` and runs them server-side — one MCP round-trip for many actions." Tasks 1–2 cover the schema and orchestrator, Task 3 covers end-to-end, Task 4 covers discoverability. ✓
2. **Placeholder scan:** every step has runnable commands and full code blocks. ✓
3. **Type consistency:** `BATCHABLE_TOOLS` (Task 1) is the same enum referenced by `registry` (Task 2). `PageBatchParamsSchema.steps[].tool` is `z.enum(BATCHABLE_TOOLS)`, which by construction matches every key in `registry`. The fallback `if (!handler)` is defensive, not load-bearing. ✓

## Out of Scope (intentionally)

- **Parallelism.** Steps run sequentially. Most useful batches (click → type) have implicit ordering. Parallel batching is a future tool, not this one.
- **Per-step `profile` override.** The whole batch shares one profile. Cross-profile orchestration belongs in the calling agent.
- **Snapshot caching across steps.** Snapshots are already invalidated on any DOM mutation. Each step takes its own (existing behaviour); no cross-step short-circuit.
- **Wire-protocol changes.** The extension never learns about batching. If a future profiling run shows the loopback WS hop is the bottleneck (it won't), revisit.
