import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub chrome.* used in the DebuggerManager constructor. Must happen BEFORE import.
beforeEach(() => {
  (globalThis as any).chrome = {
    tabs: { onRemoved: { addListener: vi.fn() } },
    debugger: {
      onEvent: { addListener: vi.fn() },
      onDetach: { addListener: vi.fn() },
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async () => ({})),
    },
  };
});
afterEach(() => { delete (globalThis as any).chrome; });

// Import AFTER the stub is in place so the constructor's addListener calls hit the mocks.
import { DebuggerManager, RingBuffer } from "../src/lib/debugger-manager.js";

describe("RingBuffer", () => {
  it("caps the oldest items when capacity is exceeded", () => {
    const b = new RingBuffer<{ ts: number; v: number }>(3);
    [1, 2, 3, 4, 5].forEach((v) => b.push({ ts: v, v }));
    expect(b.size()).toBe(3);
    const items = b.read({ limit: 10 }, () => "");
    expect(items.map((i) => i.v)).toEqual([3, 4, 5]);
  });

  it("filters by `since` timestamp", () => {
    const b = new RingBuffer<{ ts: number }>(100);
    [1, 2, 3, 4, 5].forEach((ts) => b.push({ ts }));
    const items = b.read({ since: 3, limit: 100 }, () => "");
    expect(items.map((i) => i.ts)).toEqual([4, 5]);
  });

  it("filters by regex pattern against extract(entry)", () => {
    const b = new RingBuffer<{ ts: number; text: string }>(100);
    ["error: foo", "info: bar", "error: baz"].forEach((text, i) => b.push({ ts: i, text }));
    const items = b.read({ pattern: /error/, limit: 100 }, (e) => e.text);
    expect(items.map((i) => i.text)).toEqual(["error: foo", "error: baz"]);
  });

  it("applies `limit` after filtering (returns the last N matches)", () => {
    const b = new RingBuffer<{ ts: number; text: string }>(100);
    for (let i = 1; i <= 5; i++) b.push({ ts: i, text: "error" });
    const items = b.read({ limit: 2 }, (e) => e.text);
    expect(items.map((i) => i.ts)).toEqual([4, 5]);
  });
});

describe("DebuggerManager.onEvent", () => {
  it("records console.log entries into the per-tab console buffer", async () => {
    const m = new DebuggerManager();
    await m.attach(1);
    m.onEvent({ tabId: 1 }, "Runtime.consoleAPICalled", {
      type: "log",
      args: [{ value: "hello" }, { value: "world" }],
    });
    const entries = m.readConsole(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toBe("hello world");
    expect(entries[0]!.level).toBe("log");
  });

  it("records Runtime.exceptionThrown as an error-level console entry", async () => {
    const m = new DebuggerManager();
    await m.attach(1);
    m.onEvent({ tabId: 1 }, "Runtime.exceptionThrown", {
      exceptionDetails: { text: "Uncaught TypeError: x is undefined" },
    });
    const entries = m.readConsole(1);
    expect(entries[0]!.level).toBe("error");
    expect(entries[0]!.text).toMatch(/TypeError/);
  });

  it("pairs Network.requestWillBeSent with Network.responseReceived", async () => {
    const m = new DebuggerManager();
    await m.attach(1);
    m.onEvent({ tabId: 1 }, "Network.requestWillBeSent", {
      requestId: "r1",
      request: { method: "GET", url: "https://a.test/x" },
      type: "XHR",
    });
    m.onEvent({ tabId: 1 }, "Network.responseReceived", {
      requestId: "r1",
      response: { status: 200 },
    });
    const entries = m.readNetwork(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.method).toBe("GET");
    expect(entries[0]!.url).toBe("https://a.test/x");
    expect(entries[0]!.status).toBe(200);
    expect(entries[0]!.type).toBe("XHR");
  });

  it("ignores events for tabs that haven't been attached", () => {
    const m = new DebuggerManager();
    m.onEvent({ tabId: 42 }, "Runtime.consoleAPICalled", {
      type: "log", args: [{ value: "nope" }],
    });
    expect(m.readConsole(42)).toEqual([]);
  });

  it("readConsole applies pattern filter to the text field", async () => {
    const m = new DebuggerManager();
    await m.attach(1);
    m.onEvent({ tabId: 1 }, "Runtime.consoleAPICalled", { type: "log", args: [{ value: "one" }] });
    m.onEvent({ tabId: 1 }, "Runtime.consoleAPICalled", { type: "log", args: [{ value: "two" }] });
    const filtered = m.readConsole(1, "tw");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.text).toBe("two");
  });

  it("readNetwork applies pattern filter to the url field", async () => {
    const m = new DebuggerManager();
    await m.attach(1);
    m.onEvent({ tabId: 1 }, "Network.requestWillBeSent", {
      requestId: "r1", request: { method: "GET", url: "https://a.test/x" }, type: "XHR",
    });
    m.onEvent({ tabId: 1 }, "Network.responseReceived", { requestId: "r1", response: { status: 200 }});
    m.onEvent({ tabId: 1 }, "Network.requestWillBeSent", {
      requestId: "r2", request: { method: "POST", url: "https://other.test/y" }, type: "XHR",
    });
    m.onEvent({ tabId: 1 }, "Network.responseReceived", { requestId: "r2", response: { status: 201 }});
    const filtered = m.readNetwork(1, "a\\.test");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.url).toBe("https://a.test/x");
  });
});

describe("DebuggerManager.onDetach", () => {
  it("onDetach removes the tab from the attached set", async () => {
    const m = new DebuggerManager();
    await m.attach(1);
    // Grab the onDetach callback the constructor registered.
    const addListener = (globalThis as any).chrome.debugger.onDetach.addListener as ReturnType<typeof vi.fn>;
    const [cb] = addListener.mock.calls[0]!;
    cb({ tabId: 1 }, "target_closed");
    // Next sendCommand must re-attach.
    const attachSpy = (globalThis as any).chrome.debugger.attach as ReturnType<typeof vi.fn>;
    attachSpy.mockClear();
    await m.sendCommand(1, "Runtime.evaluate", { expression: "1" });
    expect(attachSpy).toHaveBeenCalledWith({ tabId: 1 }, "1.3");
  });

  it("sendCommand retries once on 'Debugger is not attached' error", async () => {
    const m = new DebuggerManager();
    await m.attach(1);
    const sendSpy = (globalThis as any).chrome.debugger.sendCommand as ReturnType<typeof vi.fn>;
    const attachSpy = (globalThis as any).chrome.debugger.attach as ReturnType<typeof vi.fn>;
    // Make the first Runtime.evaluate call throw a not-attached error, second succeeds.
    let evalCallCount = 0;
    sendSpy.mockImplementation(async (_target: any, method: string) => {
      if (method === "Runtime.evaluate") {
        evalCallCount++;
        if (evalCallCount === 1) throw new Error("Debugger is not attached to the tab with id: 1");
        return { result: { type: "string", value: "ok" } };
      }
      return {};
    });
    attachSpy.mockClear();
    const result = await m.sendCommand(1, "Runtime.evaluate", { expression: "1" });
    expect(result).toEqual({ result: { type: "string", value: "ok" } });
    // Should have re-attached once during retry.
    expect(attachSpy).toHaveBeenCalledWith({ tabId: 1 }, "1.3");
  });

  it("console entry text is truncated to 2000 characters", async () => {
    const m = new DebuggerManager();
    await m.attach(1);
    const longText = "x".repeat(3000);
    m.onEvent({ tabId: 1 }, "Runtime.consoleAPICalled", {
      type: "log",
      args: [{ value: longText }],
    });
    const entries = m.readConsole(1);
    expect(entries[0]!.text.length).toBe(2000);
  });
});
