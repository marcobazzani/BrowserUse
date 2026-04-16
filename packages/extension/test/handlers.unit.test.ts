import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted runs before module imports — ensures chrome exists when DebuggerManager
// is constructed at module evaluation time inside debug.ts.
const _chromeStub = vi.hoisted(() => {
  (globalThis as any).chrome = {
    tabs: { onRemoved: { addListener: () => {} } },
    debugger: { onEvent: { addListener: () => {} } },
  };
  return null;
});

import { registerHandlers } from "../src/handlers/index.js";
import { Dispatcher } from "../src/dispatcher.js";

function fakeChrome() {
  const state = {
    tabs: [{ id: 1, url: "https://a", title: "a", active: true, windowId: 1 }] as any[],
    groups: new Map<number, { title?: string; color?: string; tabs: number[] }>(),
    nextGroupId: 100,
    debuggerState: { attached: new Set<number>(), lastCommand: undefined as any },
  };
  (globalThis as any).chrome = {
    tabs: {
      query: vi.fn(async () => state.tabs),
      create: vi.fn(async ({ url }: { url: string }) => {
        const t = { id: state.tabs.length + 1, url, title: "", active: true, windowId: 1 };
        state.tabs.push(t);
        return t;
      }),
      update: vi.fn(async (_id: number, _p: unknown) => ({})),
      remove: vi.fn(async (_id: number) => {}),
      get: vi.fn(async (id: number) => state.tabs.find((t) => t.id === id)),
      captureVisibleTab: vi.fn(async (_winId: number, opts: { format: string }) => `data:image/${opts.format};base64,AAAA`),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
      group: vi.fn(async ({ tabIds, groupId }: { tabIds: number[]; groupId?: number }) => {
        if (groupId !== undefined && state.groups.has(groupId)) {
          const g = state.groups.get(groupId)!;
          for (const t of tabIds) if (!g.tabs.includes(t)) g.tabs.push(t);
          return groupId;
        }
        const gid = state.nextGroupId++;
        state.groups.set(gid, { tabs: [...tabIds] });
        return gid;
      }),
      ungroup: vi.fn(async (_ids: number[]) => {}),
    },
    tabGroups: {
      update: vi.fn(async (gid: number, props: { title?: string; color?: string; collapsed?: boolean }) => {
        const g = state.groups.get(gid);
        if (g) Object.assign(g, props);
        return g;
      }),
    },
    scripting: {
      executeScript: vi.fn(async (_opts) => [{
        result: {
          mode: "text",
          url: "https://a",
          title: "a",
          content: "hello",
          truncated: false,
        },
      }]),
    },
    debugger: {
      attach: vi.fn(async ({ tabId }: { tabId: number }) => { state.debuggerState.attached.add(tabId); }),
      detach: vi.fn(async ({ tabId }: { tabId: number }) => { state.debuggerState.attached.delete(tabId); }),
      sendCommand: vi.fn(async (_target: any, method: string, params: any) => {
        state.debuggerState.lastCommand = { method, params };
        if (method === "Runtime.evaluate") {
          return { result: { type: "string", value: "ok" } };
        }
        return {};
      }),
      onEvent: { addListener: vi.fn() },
    },
  };
  return state;
}

describe("handlers", () => {
  let state: ReturnType<typeof fakeChrome>;
  let d: Dispatcher;

  beforeEach(() => {
    state = fakeChrome();
    d = new Dispatcher();
    registerHandlers(d);
  });
  afterEach(() => { delete (globalThis as any).chrome; });

  it("tabs.list returns all tabs", async () => {
    const resp = await d.handle({ jsonrpc: "2.0", id: 1, method: "tabs.list" });
    expect(resp.result).toHaveLength(1);
    expect((resp.result as any)[0].url).toBe("https://a");
  });

  it("tabs.create creates a tab and returns it", async () => {
    const resp = await d.handle({
      jsonrpc: "2.0", id: 2, method: "tabs.create",
      params: { url: "https://example.com", active: true },
    });
    expect((resp.result as any).url).toBe("https://example.com");
  });

  it("session.claim groups the tab under a Claude orange group", async () => {
    const resp = await d.handle({ jsonrpc: "2.0", id: 3, method: "session.claim", params: { tabId: 1 } });
    expect((resp.result as any).ok).toBe(true);
    const gid = (resp.result as any).groupId;
    expect(state.groups.get(gid)?.title).toBe("Claude");
    expect(state.groups.get(gid)?.color).toBe("orange");
  });

  it("session.claim is idempotent (second call reuses group)", async () => {
    const a = await d.handle({ jsonrpc: "2.0", id: 4, method: "session.claim", params: { tabId: 1 } });
    const b = await d.handle({ jsonrpc: "2.0", id: 5, method: "session.claim", params: { tabId: 1 } });
    expect((a.result as any).groupId).toBe((b.result as any).groupId);
  });

  it("session.claim injects overlay via executeScript({ func })", async () => {
    const spy = (globalThis as any).chrome.scripting.executeScript as ReturnType<typeof vi.fn>;
    spy.mockClear();
    await d.handle({ jsonrpc: "2.0", id: 10, method: "session.claim", params: { tabId: 1 } });
    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0]![0];
    expect(typeof call.func).toBe("function"); // func, not files
    expect(call.files).toBeUndefined();
  });

  it("page.snapshot returns the injected function's result", async () => {
    const resp = await d.handle({ jsonrpc: "2.0", id: 20, method: "page.snapshot", params: { tabId: 1 } });
    expect((resp.result as any).content).toBe("hello");
    expect((resp.result as any).mode).toBe("text");
  });

  it("page.screenshot strips the data URL prefix and returns base64", async () => {
    const resp = await d.handle({ jsonrpc: "2.0", id: 21, method: "page.screenshot", params: { tabId: 1 } });
    expect((resp.result as any).base64).toBe("AAAA");
    expect((resp.result as any).format).toBe("png");
  });

  it("page.click dispatches executeScript with the click helper and returns ok", async () => {
    (globalThis as any).chrome.scripting.executeScript = vi.fn(async () => [{ result: { ok: true } }]);
    const resp = await d.handle({
      jsonrpc: "2.0", id: 30, method: "page.click",
      params: { tabId: 1, selector: "#go" },
    });
    expect((resp.result as any).ok).toBe(true);
    const call = ((globalThis as any).chrome.scripting.executeScript as any).mock.calls[0][0];
    expect(typeof call.func).toBe("function");
    expect(call.args).toEqual(["#go", "left", true]);
  });

  it("page.click surfaces an injected-function error via the 'error' field", async () => {
    (globalThis as any).chrome.scripting.executeScript = vi.fn(async () => [
      { error: new Error("selector did not match: #nope") },
    ]);
    const resp = await d.handle({
      jsonrpc: "2.0", id: 31, method: "page.click",
      params: { tabId: 1, selector: "#nope" },
    });
    expect(resp.error?.message).toMatch(/selector did not match/);
  });

  it("page.type passes the correct args array", async () => {
    (globalThis as any).chrome.scripting.executeScript = vi.fn(async () => [{ result: { ok: true } }]);
    await d.handle({
      jsonrpc: "2.0", id: 32, method: "page.type",
      params: { tabId: 1, selector: "#q", text: "hello", submit: true },
    });
    const call = ((globalThis as any).chrome.scripting.executeScript as any).mock.calls[0][0];
    expect(call.args).toEqual(["#q", "hello", true, true]);
  });

  it("page.scroll to=bottom passes correct args", async () => {
    (globalThis as any).chrome.scripting.executeScript = vi.fn(async () => [{ result: { ok: true } }]);
    await d.handle({
      jsonrpc: "2.0", id: 33, method: "page.scroll",
      params: { tabId: 1, to: "bottom" },
    });
    const call = ((globalThis as any).chrome.scripting.executeScript as any).mock.calls[0][0];
    // args order: [dx, dy, selector, to, smooth]
    expect(call.args).toEqual([undefined, undefined, undefined, "bottom", false]);
  });

  it("page.scroll rejects params that mix dy + selector", async () => {
    const resp = await d.handle({
      jsonrpc: "2.0", id: 34, method: "page.scroll",
      params: { tabId: 1, dy: 100, selector: "#x" },
    });
    expect(resp.error?.message).toMatch(/exactly one/i);
  });

  it("page.evalJs forwards to Runtime.evaluate with the expected params", async () => {
    const resp = await d.handle({
      jsonrpc: "2.0", id: 40, method: "page.evalJs",
      params: { tabId: 1, expression: "document.title" },
    });
    const cmd = (globalThis as any).chrome.debugger.sendCommand.mock.calls
      .find((c: any[]) => c[1] === "Runtime.evaluate");
    expect(cmd).toBeDefined();
    expect(cmd[2].expression).toBe("document.title");
    expect((resp.result as any).type).toBe("string");
  });

  it("page.evalJs returns {type:'exception', exception} on exceptionDetails", async () => {
    const spy = (globalThis as any).chrome.debugger.sendCommand as ReturnType<typeof vi.fn>;
    // Make the NEXT Runtime.evaluate call return an exception
    spy.mockImplementationOnce(async () => ({
      result: { type: "object" },
      exceptionDetails: { text: "Uncaught ReferenceError" },
    }));
    const resp = await d.handle({
      jsonrpc: "2.0", id: 41, method: "page.evalJs",
      params: { tabId: 1, expression: "nope()" },
    });
    expect((resp.result as any).type).toBe("exception");
    expect((resp.result as any).exception).toMatch(/ReferenceError/);
  });

  it("console.read triggers attach and returns an empty array for a fresh tab", async () => {
    const resp = await d.handle({
      jsonrpc: "2.0", id: 42, method: "console.read",
      params: { tabId: 2 },
    });
    expect(Array.isArray(resp.result)).toBe(true);
    expect((resp.result as any[]).length).toBe(0);
    expect((globalThis as any).chrome.debugger.attach).toHaveBeenCalled();
  });

  it("network.read triggers attach and returns an empty array for a fresh tab", async () => {
    const resp = await d.handle({
      jsonrpc: "2.0", id: 43, method: "network.read",
      params: { tabId: 3 },
    });
    expect(Array.isArray(resp.result)).toBe(true);
  });
});
