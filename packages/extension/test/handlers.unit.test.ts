import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted runs before module imports — ensures chrome exists when DebuggerManager
// is constructed at module evaluation time inside debug.ts.
const _chromeStub = vi.hoisted(() => {
  (globalThis as any).chrome = {
    tabs: { onRemoved: { addListener: () => {} } },
    debugger: {
      onEvent: { addListener: () => {} },
      onDetach: { addListener: () => {} },
    },
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
    debuggerState: { attached: new Set<number>(), commands: [] as any[] },
  };
  (globalThis as any).chrome = {
    tabs: {
      query: vi.fn(async (q: { active?: boolean; lastFocusedWindow?: boolean }) => {
        if (q.active && q.lastFocusedWindow) return [{ id: 99, url: "https://active", title: "active", active: true, windowId: 1 }];
        return state.tabs;
      }),
      create: vi.fn(async ({ url }: { url: string }) => {
        const t = { id: state.tabs.length + 1, url, title: "", active: true, windowId: 1 };
        state.tabs.push(t);
        return t;
      }),
      update: vi.fn(async (_id: number, _p: unknown) => ({})),
      remove: vi.fn(async (_id: number) => {}),
      get: vi.fn(async (id: number) => state.tabs.find((t) => t.id === id) ?? { id, url: "https://a", title: "a", windowId: 1 }),
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
      executeScript: vi.fn(async (opts: any) => {
        // For text/dom snapshot modes (injected function) and scroll.
        if (opts.func) {
          return [{ result: { mode: "text", url: "https://a", title: "a", content: "hello", truncated: false } }];
        }
        return [{ result: { ok: true } }];
      }),
    },
    action: {
      setBadgeText: vi.fn(async (_p) => {}),
      setBadgeBackgroundColor: vi.fn(async (_p) => {}),
    },
    debugger: {
      attach: vi.fn(async ({ tabId }: { tabId: number }) => { state.debuggerState.attached.add(tabId); }),
      detach: vi.fn(async ({ tabId }: { tabId: number }) => { state.debuggerState.attached.delete(tabId); }),
      sendCommand: vi.fn(async (_target: any, method: string, params: any) => {
        state.debuggerState.commands.push({ method, params });
        if (method === "Runtime.enable" || method === "Network.enable" || method === "Accessibility.enable" || method === "Page.enable") return {};
        if (method === "Runtime.evaluate") return { result: { type: "string", value: "ok" } };
        if (method === "Runtime.callFunctionOn") {
          // page.select uses returnByValue to return the picked values array.
          if (params?.functionDeclaration?.includes("page.select target") || params?.functionDeclaration?.includes("picked")) {
            return { result: { type: "object", value: ["opt1"] } };
          }
          return { result: { type: "undefined" } };
        }
        if (method === "Page.handleJavaScriptDialog") return {};
        if (method === "DOM.setFileInputFiles") return {};
        if (method === "Accessibility.getFullAXTree") {
          return {
            nodes: [
              { nodeId: "1", backendDOMNodeId: 10, role: { type: "role", value: "WebArea" }, name: { type: "computedString", value: "Test Page" }, childIds: ["2", "3"] },
              { nodeId: "2", backendDOMNodeId: 20, role: { type: "role", value: "button" }, name: { type: "computedString", value: "Submit" }, properties: [{ name: "focusable", value: { type: "boolean", value: true } }] },
              { nodeId: "3", backendDOMNodeId: 30, role: { type: "role", value: "textbox" }, name: { type: "computedString", value: "Email" }, properties: [{ name: "focusable", value: { type: "boolean", value: true } }] },
            ],
          };
        }
        if (method === "DOM.resolveNode") return { object: { objectId: "obj-" + (params.backendNodeId ?? params.nodeId) } };
        if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
        if (method === "DOM.querySelector") return { nodeId: params.selector === "#missing" ? 0 : 42 };
        if (method === "DOM.getBoxModel") return { model: { content: [100, 100, 200, 100, 200, 200, 100, 200] } };
        if (method === "Input.dispatchMouseEvent") return {};
        if (method === "Input.dispatchKeyEvent") return {};
        if (method === "Input.insertText") return {};
        return {};
      }),
      onEvent: { addListener: vi.fn() },
      onDetach: { addListener: vi.fn() },
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
    expect(typeof call.func).toBe("function");
    expect(call.files).toBeUndefined();
  });

  // --- page.snapshot ---
  it("page.snapshot mode=a11y returns CDP accessibility tree with uids", async () => {
    const resp = await d.handle({ jsonrpc: "2.0", id: 20, method: "page.snapshot", params: { tabId: 1 } });
    const result = resp.result as any;
    expect(result.mode).toBe("a11y");
    expect(result.content).toContain("button");
    expect(result.content).toContain("Submit");
    // UIDs should be present.
    expect(result.content).toMatch(/\[e\d+\]/);
  });

  it("page.snapshot mode=text returns innerText via executeScript", async () => {
    const resp = await d.handle({ jsonrpc: "2.0", id: 21, method: "page.snapshot", params: { tabId: 1, mode: "text" } });
    expect((resp.result as any).content).toBe("hello");
    expect((resp.result as any).mode).toBe("text");
  });

  it("page.screenshot strips the data URL prefix and returns base64", async () => {
    const resp = await d.handle({ jsonrpc: "2.0", id: 22, method: "page.screenshot", params: { tabId: 1 } });
    expect((resp.result as any).base64).toBe("AAAA");
    expect((resp.result as any).format).toBe("jpeg");
  });

  it("page.snapshot with no tabId resolves to the active tab", async () => {
    const resp = await d.handle({ jsonrpc: "2.0", id: 60, method: "page.snapshot", params: {} });
    expect(resp.error).toBeUndefined();
  });

  /** Helper: take a snapshot and extract uids from the content. */
  async function snapshotUids(tabId: number): Promise<string[]> {
    const resp = await d.handle({ jsonrpc: "2.0", id: Date.now(), method: "page.snapshot", params: { tabId } });
    const content = (resp.result as any).content as string;
    return [...content.matchAll(/\[(e\d+)\]/g)].map(m => m[1]);
  }

  // --- page.click (CDP-based) ---
  it("page.click with uid dispatches CDP mouse events", async () => {
    const uids = await snapshotUids(1);
    expect(uids.length).toBeGreaterThanOrEqual(2);
    const resp = await d.handle({
      jsonrpc: "2.0", id: 71, method: "page.click",
      params: { tabId: 1, uid: uids[0] },
    });
    expect((resp.result as any).ok).toBe(true);
    const mouseEvents = state.debuggerState.commands.filter((c: any) => c.method === "Input.dispatchMouseEvent");
    expect(mouseEvents.length).toBeGreaterThanOrEqual(2); // mousePressed + mouseReleased
  });

  it("page.click with selector resolves via DOM.querySelector", async () => {
    const resp = await d.handle({
      jsonrpc: "2.0", id: 72, method: "page.click",
      params: { tabId: 1, selector: "#go" },
    });
    expect((resp.result as any).ok).toBe(true);
    const qsCalls = state.debuggerState.commands.filter((c: any) => c.method === "DOM.querySelector");
    expect(qsCalls.length).toBe(1);
    expect(qsCalls[0].params.selector).toBe("#go");
  });

  it("page.click rejects when neither uid nor selector", async () => {
    const resp = await d.handle({
      jsonrpc: "2.0", id: 73, method: "page.click",
      params: { tabId: 1 },
    });
    expect(resp.error).toBeDefined();
  });

  // --- page.type (CDP-based) ---
  it("page.type with uid focuses and inserts text via CDP", async () => {
    const uids = await snapshotUids(1);
    state.debuggerState.commands = [];
    const resp = await d.handle({
      jsonrpc: "2.0", id: 81, method: "page.type",
      params: { tabId: 1, uid: uids[1], text: "hello@test.com" },
    });
    expect((resp.result as any).ok).toBe(true);
    const insertCalls = state.debuggerState.commands.filter((c: any) => c.method === "Input.insertText");
    expect(insertCalls.length).toBe(1);
    expect(insertCalls[0].params.text).toBe("hello@test.com");
  });

  // --- page.hover ---
  it("page.hover dispatches mouseMoved event", async () => {
    const uids = await snapshotUids(1);
    state.debuggerState.commands = [];
    const resp = await d.handle({
      jsonrpc: "2.0", id: 91, method: "page.hover",
      params: { tabId: 1, uid: uids[0] },
    });
    expect((resp.result as any).ok).toBe(true);
    const hoverEvents = state.debuggerState.commands.filter((c: any) =>
      c.method === "Input.dispatchMouseEvent" && c.params.type === "mouseMoved"
    );
    expect(hoverEvents.length).toBe(1);
  });

  // --- page.pressKey ---
  it("page.pressKey dispatches keyDown + keyUp", async () => {
    const resp = await d.handle({
      jsonrpc: "2.0", id: 100, method: "page.pressKey",
      params: { tabId: 1, key: "Enter" },
    });
    expect((resp.result as any).ok).toBe(true);
    const keyEvents = state.debuggerState.commands.filter((c: any) => c.method === "Input.dispatchKeyEvent");
    expect(keyEvents.length).toBe(2);
    expect(keyEvents[0].params.type).toBe("keyDown");
    expect(keyEvents[1].params.type).toBe("keyUp");
    expect(keyEvents[0].params.key).toBe("Enter");
  });

  // --- page.fillForm ---
  it("page.fillForm fills multiple fields in one call", async () => {
    const uids = await snapshotUids(1);
    state.debuggerState.commands = [];
    const resp = await d.handle({
      jsonrpc: "2.0", id: 111, method: "page.fillForm",
      params: {
        tabId: 1,
        fields: [
          { uid: uids[0], value: "Alice" },
          { uid: uids[1], value: "alice@example.com" },
        ],
      },
    });
    expect((resp.result as any).ok).toBe(true);
    expect((resp.result as any).filledCount).toBe(2);
    const insertCalls = state.debuggerState.commands.filter((c: any) => c.method === "Input.insertText");
    expect(insertCalls.length).toBe(2);
  });

  // --- page.scroll ---
  it("page.scroll to=bottom passes correct args", async () => {
    const resp = await d.handle({
      jsonrpc: "2.0", id: 33, method: "page.scroll",
      params: { tabId: 1, to: "bottom" },
    });
    expect((resp.result as any).ok).toBe(true);
  });

  it("page.scroll rejects params that mix dy + selector", async () => {
    const resp = await d.handle({
      jsonrpc: "2.0", id: 34, method: "page.scroll",
      params: { tabId: 1, dy: 100, selector: "#x" },
    });
    expect(resp.error?.message).toMatch(/exactly one/i);
  });

  // --- page.evalJs ---
  it("page.evalJs forwards to Runtime.evaluate", async () => {
    const resp = await d.handle({
      jsonrpc: "2.0", id: 40, method: "page.evalJs",
      params: { tabId: 1, expression: "document.title" },
    });
    const cmd = state.debuggerState.commands.find((c: any) => c.method === "Runtime.evaluate");
    expect(cmd).toBeDefined();
    expect(cmd.params.expression).toBe("document.title");
    expect((resp.result as any).type).toBe("string");
  });

  it("page.evalJs returns {type:'exception', exception} on exceptionDetails", async () => {
    const origSendCommand = (globalThis as any).chrome.debugger.sendCommand;
    (globalThis as any).chrome.debugger.sendCommand = vi.fn(async (_target: any, method: string, params: any) => {
      if (method === "Runtime.evaluate") {
        return { result: { type: "object" }, exceptionDetails: { text: "Uncaught ReferenceError" } };
      }
      // Delegate everything else to original.
      return origSendCommand(_target, method, params);
    });
    const resp = await d.handle({
      jsonrpc: "2.0", id: 41, method: "page.evalJs",
      params: { tabId: 1, expression: "nope()" },
    });
    expect((resp.result as any).type).toBe("exception");
    expect((resp.result as any).exception).toMatch(/ReferenceError/);
    // Restore.
    (globalThis as any).chrome.debugger.sendCommand = origSendCommand;
  });

  // --- console / network ---
  it("console.read triggers attach and returns an empty array for a fresh tab", async () => {
    const resp = await d.handle({
      jsonrpc: "2.0", id: 42, method: "console.read",
      params: { tabId: 2 },
    });
    expect(Array.isArray(resp.result)).toBe(true);
    expect((globalThis as any).chrome.debugger.attach).toHaveBeenCalled();
  });

  it("network.read triggers attach and returns an empty array for a fresh tab", async () => {
    const resp = await d.handle({
      jsonrpc: "2.0", id: 43, method: "network.read",
      params: { tabId: 3 },
    });
    expect(Array.isArray(resp.result)).toBe(true);
  });

  it("session.claim sets the toolbar badge when overlay injection fails", async () => {
    const spy = (globalThis as any).chrome.scripting.executeScript as ReturnType<typeof vi.fn>;
    spy.mockImplementationOnce(async () => { throw new Error("CSP blocked"); });

    await d.handle({ jsonrpc: "2.0", id: 50, method: "session.claim", params: { tabId: 1 } });

    const badge = (globalThis as any).chrome.action.setBadgeText as ReturnType<typeof vi.fn>;
    expect(badge).toHaveBeenCalledWith(expect.objectContaining({ tabId: 1, text: "●" }));
  });

  // --- page.handleDialog ---
  it("page.handleDialog returns handled=false when no dialog pending", async () => {
    const resp = await d.handle({
      jsonrpc: "2.0", id: 200, method: "page.handleDialog",
      params: { tabId: 1, action: "accept" },
    });
    expect((resp.result as any).ok).toBe(true);
    expect((resp.result as any).handled).toBe(false);
  });

  // --- page.select ---
  it("page.select calls Runtime.callFunctionOn on a resolved element", async () => {
    const uids = await snapshotUids(1);
    state.debuggerState.commands = [];
    const resp = await d.handle({
      jsonrpc: "2.0", id: 210, method: "page.select",
      params: { tabId: 1, uid: uids[0], values: ["opt1"] },
    });
    expect((resp.result as any).ok).toBe(true);
    const fnCalls = state.debuggerState.commands.filter((c: any) => c.method === "Runtime.callFunctionOn");
    expect(fnCalls.length).toBeGreaterThanOrEqual(1);
  });

  // --- page.uploadFile ---
  it("page.uploadFile calls DOM.setFileInputFiles with the given paths", async () => {
    const uids = await snapshotUids(1);
    state.debuggerState.commands = [];
    const resp = await d.handle({
      jsonrpc: "2.0", id: 220, method: "page.uploadFile",
      params: { tabId: 1, uid: uids[0], filePaths: ["/tmp/a.png"] },
    });
    expect((resp.result as any).ok).toBe(true);
    expect((resp.result as any).uploadedCount).toBe(1);
    const sffiCalls = state.debuggerState.commands.filter((c: any) => c.method === "DOM.setFileInputFiles");
    expect(sffiCalls.length).toBe(1);
    expect(sffiCalls[0].params.files).toEqual(["/tmp/a.png"]);
  });

  // --- cross-extension fallback in page.type ---
  it("page.type falls back to coordinate click when focus hits 'chrome-extension://' error", async () => {
    const uids = await snapshotUids(1);
    state.debuggerState.commands = [];
    const origSend = (globalThis as any).chrome.debugger.sendCommand;
    (globalThis as any).chrome.debugger.sendCommand = vi.fn(async (t: any, method: string, params: any) => {
      if (method === "Runtime.callFunctionOn" && params?.functionDeclaration?.includes("focus()")) {
        throw new Error("Cannot access a chrome-extension:// URL of different extension");
      }
      return origSend(t, method, params);
    });
    const resp = await d.handle({
      jsonrpc: "2.0", id: 300, method: "page.type",
      params: { tabId: 1, uid: uids[1], text: "secret123" },
    });
    // Should succeed via fallback
    expect((resp.result as any).ok).toBe(true);
    // insertText must still have run
    const calls = ((globalThis as any).chrome.debugger.sendCommand as any).mock.calls.map((a: any[]) => a[1]);
    expect(calls).toContain("Input.insertText");
    // Coordinate-click (mousePressed + mouseReleased) must have been used
    const mouseEvents = ((globalThis as any).chrome.debugger.sendCommand as any).mock.calls
      .filter((a: any[]) => a[1] === "Input.dispatchMouseEvent")
      .map((a: any[]) => a[2].type);
    expect(mouseEvents).toContain("mousePressed");
    expect(mouseEvents).toContain("mouseReleased");
    (globalThis as any).chrome.debugger.sendCommand = origSend;
  });

  it("page.type surfaces a human-readable error when cross-extension blocks everything", async () => {
    const uids = await snapshotUids(1);
    const origSend = (globalThis as any).chrome.debugger.sendCommand;
    (globalThis as any).chrome.debugger.sendCommand = vi.fn(async (_t: any, method: string, _p: any) => {
      if (method === "Runtime.enable" || method === "Network.enable" || method === "Accessibility.enable" || method === "Page.enable") return {};
      throw new Error("Cannot access a chrome-extension:// URL of different extension");
    });
    const resp = await d.handle({
      jsonrpc: "2.0", id: 301, method: "page.type",
      params: { tabId: 1, uid: uids[1], text: "x" },
    });
    expect(resp.error?.message).toMatch(/interaction blocked by another Chrome extension/i);
    (globalThis as any).chrome.debugger.sendCommand = origSend;
  });

  // --- DebuggerManager retry broadened ---
  it("sendCommand retries once on 'Detached while handling command'", async () => {
    // Re-use the pending pair manager indirectly via any CDP-using handler.
    let calls = 0;
    const origSend = (globalThis as any).chrome.debugger.sendCommand;
    (globalThis as any).chrome.debugger.sendCommand = vi.fn(async (t: any, method: string, params: any) => {
      if (method === "Accessibility.getFullAXTree") {
        calls++;
        if (calls === 1) throw new Error("Detached while handling command.");
        return origSend(t, method, params);
      }
      return origSend(t, method, params);
    });
    const resp = await d.handle({ jsonrpc: "2.0", id: 310, method: "page.snapshot", params: { tabId: 1 } });
    expect(resp.error).toBeUndefined();
    expect(calls).toBe(2);
    (globalThis as any).chrome.debugger.sendCommand = origSend;
  });

  // --- page.drag ---
  // --- page.fetch ---
  it("page.fetch runs Runtime.evaluate with a fetch() wrapper and returns the in-page response", async () => {
    const origSend = (globalThis as any).chrome.debugger.sendCommand;
    (globalThis as any).chrome.debugger.sendCommand = vi.fn(async (t: any, method: string, params: any) => {
      if (method === "Runtime.evaluate" && params?.expression?.includes("await fetch(cfg.url")) {
        return {
          result: {
            type: "object",
            value: {
              ok: true, status: 200, statusText: "OK",
              headers: { "content-type": "application/json" },
              body: { id: 42 }, json: true, truncated: false, finalUrl: "https://x/api/y",
            },
          },
        };
      }
      return origSend(t, method, params);
    });
    const resp = await d.handle({
      jsonrpc: "2.0", id: 500, method: "page.fetch",
      params: { tabId: 1, url: "/api/y", method: "POST", body: { q: 1 } },
    });
    const r = resp.result as any;
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.json).toBe(true);
    expect(r.body).toEqual({ id: 42 });
    // Ensure the body we embedded in the expression was stringified JSON
    const evalCall = ((globalThis as any).chrome.debugger.sendCommand as any).mock.calls
      .find((a: any[]) => a[1] === "Runtime.evaluate");
    expect(evalCall[2].expression).toContain('"method":"POST"');
    expect(evalCall[2].expression).toContain('"body":"{\\"q\\":1}"');
    (globalThis as any).chrome.debugger.sendCommand = origSend;
  });

  it("page.fetch surfaces an in-page fetch failure via _error", async () => {
    const origSend = (globalThis as any).chrome.debugger.sendCommand;
    (globalThis as any).chrome.debugger.sendCommand = vi.fn(async (t: any, method: string, params: any) => {
      if (method === "Runtime.evaluate" && params?.expression?.includes("await fetch(cfg.url")) {
        return {
          result: {
            type: "object",
            value: {
              ok: false, status: 0, statusText: "",
              headers: {}, body: null, json: false, truncated: false,
              finalUrl: "/api/y", _error: "NetworkError: Failed to fetch",
            },
          },
        };
      }
      return origSend(t, method, params);
    });
    const resp = await d.handle({
      jsonrpc: "2.0", id: 501, method: "page.fetch",
      params: { tabId: 1, url: "/api/y" },
    });
    expect(resp.error?.message).toMatch(/NetworkError|failed/i);
    (globalThis as any).chrome.debugger.sendCommand = origSend;
  });

  // --- page.drag ---
  it("page.drag dispatches press + moves + release mouse events", async () => {
    const uids = await snapshotUids(1);
    state.debuggerState.commands = [];
    const resp = await d.handle({
      jsonrpc: "2.0", id: 230, method: "page.drag",
      params: { tabId: 1, fromUid: uids[0], toUid: uids[1], steps: 5 },
    });
    expect((resp.result as any).ok).toBe(true);
    const mouseEvents = state.debuggerState.commands.filter((c: any) => c.method === "Input.dispatchMouseEvent");
    const pressed = mouseEvents.filter((c: any) => c.params.type === "mousePressed");
    const moved = mouseEvents.filter((c: any) => c.params.type === "mouseMoved");
    const released = mouseEvents.filter((c: any) => c.params.type === "mouseReleased");
    expect(pressed.length).toBe(1);
    expect(moved.length).toBe(5);
    expect(released.length).toBe(1);
  });
});
