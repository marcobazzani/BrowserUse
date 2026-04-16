# Escape hatch + logs: evalJs, console, network

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development

**Goal:** Add three tools that share a common backbone — `page.evalJs`, `console.read`, `network.read`. All three require Chrome DevTools Protocol (CDP) access via `chrome.debugger.attach`. Shipping them together amortises the shared attach-manager + buffer scaffolding.

**Safety note:** `page.evalJs` executes arbitrary JavaScript with full page privileges in the user's authenticated browser. It is a Claude-in-Chrome equivalent of `bash -c` on the browser side. Gate usage via prompt discipline — do not add runtime confirmation in v0.2 (the MVP safety model is "the human types the instructions to Claude").

**Architecture:**
- A per-tab **`DebuggerManager`** (extension-side) owns the `chrome.debugger.attach/detach` lifecycle, attaches on first use, reference-counts, buffers console + network events into ring buffers (default cap: 500 entries per tab per stream), tears down on `chrome.tabs.onRemoved`.
- `page.evalJs` sends `Runtime.evaluate` through the manager.
- `console.read` / `network.read` drain (or peek) the ring buffers with optional regex `pattern` filter and `since` timestamp.
- When a tab is attached, Chrome shows the "BrowserUse started debugging this browser" banner. That is the user's signal that the agent is actively introspecting.

---

### Task 1: Wire protocol (shared)

Schemas and METHODS entries for:

```ts
export const PageEvalJsParamsSchema = z.object({
  tabId: z.number().int(),
  expression: z.string().min(1),
  awaitPromise: z.boolean().default(true),
  returnByValue: z.boolean().default(true),
  timeoutMs: z.number().int().positive().max(30_000).default(5_000),
}).strict();
export const PageEvalJsResultSchema = z.object({
  type: z.string(),           // "string" | "number" | "object" | "undefined" | ...
  value: z.unknown().optional(),
  description: z.string().optional(),
  exception: z.string().optional(),
}).strict();

export const ConsoleEntrySchema = z.object({
  ts: z.number(),             // epoch ms
  level: z.enum(["log", "info", "warn", "error", "debug"]),
  text: z.string(),
}).strict();
export const ConsoleReadParamsSchema = z.object({
  tabId: z.number().int(),
  pattern: z.string().optional(),       // regex source; match against `text`
  since: z.number().optional(),         // epoch ms; return entries newer than this
  limit: z.number().int().positive().max(2000).default(500),
}).strict();
export const ConsoleReadResultSchema = z.array(ConsoleEntrySchema);

export const NetworkEntrySchema = z.object({
  ts: z.number(),
  method: z.string(),
  url: z.string(),
  status: z.number().int().optional(),
  durationMs: z.number().optional(),
  type: z.string(),           // Fetch / XHR / Document / ...
}).strict();
export const NetworkReadParamsSchema = z.object({
  tabId: z.number().int(),
  pattern: z.string().optional(),       // regex source; match against `url`
  since: z.number().optional(),
  limit: z.number().int().positive().max(2000).default(500),
}).strict();
export const NetworkReadResultSchema = z.array(NetworkEntrySchema);
```

Register in METHODS. Add round-trip tests for (a) default values, (b) rejection of empty expression, (c) upper-bound limits.

Commit: `feat(shared): wire schemas for page.evalJs + console.read + network.read`

---

### Task 2: MCP tool adapters

Three tools in `tools.ts` — standard pattern. `page_eval_js` auto-claims the tab; `console_read` and `network_read` do NOT (they are observational). Names use underscores per MCP convention.

Unit-test coverage: ensure the exception-returning `page.evalJs` path flows through correctly (the wire result has an `exception` field, which should not throw on the server — it's a legitimate result).

Commit: `feat(mcp-server): page_eval_js + console_read + network_read`

---

### Task 3: Extension — the `DebuggerManager`

**File:** `packages/extension/src/lib/debugger-manager.ts`

Responsibilities:
- `attach(tabId)` — attach CDP if not already; enable Runtime + Console + Network domains; register per-event listeners that push into ring buffers.
- `sendCommand(tabId, method, params)` — thin wrapper over `chrome.debugger.sendCommand`.
- `console(tabId, filter)` / `network(tabId, filter)` — filter + return buffered entries.
- `detach(tabId)` — release; called from `chrome.tabs.onRemoved` and on `session.release`.

```ts
type Buf<T> = { push: (e: T) => void; read: (filter?: { pattern?: RegExp; since?: number; limit: number }) => T[] };

export interface ConsoleEntry { ts: number; level: "log"|"info"|"warn"|"error"|"debug"; text: string; }
export interface NetworkEntry { ts: number; method: string; url: string; status?: number; durationMs?: number; type: string; }

class RingBuffer<T extends { ts: number }> implements Buf<T> {
  constructor(private cap = 500) {}
  private items: T[] = [];
  push(e: T) {
    this.items.push(e);
    if (this.items.length > this.cap) this.items.splice(0, this.items.length - this.cap);
  }
  read(filter: { pattern?: RegExp; since?: number; limit: number } = { limit: 500 }): T[] {
    return this.items
      .filter((i) => (filter.since === undefined || i.ts > filter.since))
      .filter((i) => (!filter.pattern || filter.pattern.test((i as any).text ?? (i as any).url ?? "")))
      .slice(-filter.limit);
  }
}

export class DebuggerManager {
  private consoles = new Map<number, RingBuffer<ConsoleEntry>>();
  private networks = new Map<number, RingBuffer<NetworkEntry>>();
  private attached = new Set<number>();
  private inflight = new Map<string, { start: number; method: string; url: string; type: string }>();

  constructor() {
    chrome.tabs.onRemoved.addListener((tabId) => this.detach(tabId));
    chrome.debugger.onEvent.addListener((src, method, params) => this.onEvent(src, method, params));
  }

  async attach(tabId: number) {
    if (this.attached.has(tabId)) return;
    await chrome.debugger.attach({ tabId }, "1.3");
    await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
    await chrome.debugger.sendCommand({ tabId }, "Network.enable");
    this.consoles.set(tabId, new RingBuffer());
    this.networks.set(tabId, new RingBuffer());
    this.attached.add(tabId);
  }

  async detach(tabId: number) {
    if (!this.attached.has(tabId)) return;
    await chrome.debugger.detach({ tabId }).catch(() => {});
    this.attached.delete(tabId);
    this.consoles.delete(tabId);
    this.networks.delete(tabId);
  }

  async sendCommand<T = unknown>(tabId: number, method: string, params: unknown): Promise<T> {
    await this.attach(tabId);
    return (await chrome.debugger.sendCommand({ tabId }, method, params as object)) as T;
  }

  console(tabId: number, pattern?: string, since?: number, limit = 500): ConsoleEntry[] {
    const re = pattern ? new RegExp(pattern) : undefined;
    return this.consoles.get(tabId)?.read({ pattern: re, since, limit }) ?? [];
  }

  network(tabId: number, pattern?: string, since?: number, limit = 500): NetworkEntry[] {
    const re = pattern ? new RegExp(pattern) : undefined;
    return this.networks.get(tabId)?.read({ pattern: re, since, limit }) ?? [];
  }

  private onEvent(src: chrome.debugger.Debuggee, method: string, params: any) {
    if (!src.tabId) return;
    const consoleBuf = this.consoles.get(src.tabId);
    const netBuf = this.networks.get(src.tabId);
    if (method === "Runtime.consoleAPICalled" && consoleBuf) {
      const level = (params.type as ConsoleEntry["level"]) ?? "log";
      const text = (params.args ?? [])
        .map((a: any) => a.value ?? a.description ?? "")
        .join(" ");
      consoleBuf.push({ ts: Date.now(), level, text });
    } else if (method === "Runtime.exceptionThrown" && consoleBuf) {
      consoleBuf.push({ ts: Date.now(), level: "error", text: params.exceptionDetails?.text ?? "exception" });
    } else if (method === "Network.requestWillBeSent" && netBuf) {
      this.inflight.set(params.requestId, {
        start: Date.now(),
        method: params.request.method,
        url: params.request.url,
        type: params.type ?? "Other",
      });
    } else if (method === "Network.responseReceived" && netBuf) {
      const cur = this.inflight.get(params.requestId);
      if (cur) {
        netBuf.push({
          ts: Date.now(),
          method: cur.method,
          url: cur.url,
          status: params.response.status,
          durationMs: Date.now() - cur.start,
          type: cur.type,
        });
        this.inflight.delete(params.requestId);
      }
    }
  }
}
```

Unit-test coverage (pure logic):
- `RingBuffer` cap + ordering.
- Filter by `pattern` regex, by `since` timestamp, by `limit`.
- `onEvent` dispatching — simulate events against a manager and assert buffers populate.

---

### Task 4: Three handlers

**File:** `packages/extension/src/handlers/debug.ts`

```ts
import type { Dispatcher } from "../dispatcher.js";
import { DebuggerManager } from "../lib/debugger-manager.js";
import {
  PageEvalJsParamsSchema,
  ConsoleReadParamsSchema,
  NetworkReadParamsSchema,
} from "@browseruse/shared";

const mgr = new DebuggerManager();

export function registerDebugHandlers(d: Dispatcher) {
  d.register("page.evalJs", async (raw) => {
    const p = PageEvalJsParamsSchema.parse(raw);
    type Eval = { result: { type: string; value?: unknown; description?: string }; exceptionDetails?: { text: string } };
    const r = await mgr.sendCommand<Eval>(p.tabId, "Runtime.evaluate", {
      expression: p.expression,
      awaitPromise: p.awaitPromise,
      returnByValue: p.returnByValue,
      timeout: p.timeoutMs,
    });
    if (r.exceptionDetails) {
      return { type: "exception", exception: r.exceptionDetails.text };
    }
    return { type: r.result.type, value: r.result.value, description: r.result.description };
  });

  d.register("console.read", async (raw) => {
    const p = ConsoleReadParamsSchema.parse(raw);
    await mgr.attach(p.tabId);   // idempotent — ensures buffer exists
    return mgr.console(p.tabId, p.pattern, p.since, p.limit);
  });

  d.register("network.read", async (raw) => {
    const p = NetworkReadParamsSchema.parse(raw);
    await mgr.attach(p.tabId);
    return mgr.network(p.tabId, p.pattern, p.since, p.limit);
  });
}
```

Register in `handlers/index.ts`. Extend the existing fake `chrome` global to mock `chrome.debugger` (attach, detach, sendCommand, onEvent.addListener) and drive the three handlers. Ensure the console / network handlers return buffered entries after simulated events.

---

### Task 5: Manual verification

- [ ] *"What is the user agent string of the current tab?"* — exercises `page.evalJs("navigator.userAgent")`.
- [ ] Load any JS-heavy site, ask: *"Any errors in the console in the last minute?"* — exercises `console.read` with `since`.
- [ ] *"Show me the last 5 XHR calls made by this page."* — exercises `network.read` with pattern filter.
- [ ] Observe the "BrowserUse started debugging this browser" banner — that's correct and expected.

## Out of scope

- Request/response bodies for `network.read` (only metadata today). Adding bodies means large payloads crossing the WS; do it later with an explicit per-request opt-in.
- Source-map aware stack traces for console errors.
- Subscribing to `Page` events (load, frame events) — possible but expands the manager's responsibility; revisit when a use case comes up.
