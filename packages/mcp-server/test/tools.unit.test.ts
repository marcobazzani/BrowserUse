import { describe, expect, it, vi } from "vitest";
import { buildTools } from "../src/tools.js";

const fakeBridge = () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    calls,
    bridge: {
      call: vi.fn(async (method: string, params: unknown) => {
        calls.push({ method, params });
        if (method === "tabs.list") return [{ tabId: 1, url: "https://a", title: "a", active: true }];
        if (method === "tabs.create") return { tabId: 2, url: (params as any).url, title: "", active: true };
        if (method === "page.navigate") return { ok: true, finalUrl: (params as any).url };
        if (method === "session.claim") return { ok: true, groupId: 7 };
        if (method === "page.snapshot") return { mode: "text", url: "https://x", title: "x", content: "hi", truncated: false };
        if (method === "page.screenshot") return { format: "png", base64: "aGk=" };
        if (method === "tabs.close")      return { ok: true };
        if (method === "tabs.activate")   return { ok: true };
        if (method === "session.release") return { ok: true };
        if (method === "page.click")      return { ok: true };
        if (method === "page.type")       return { ok: true };
        if (method === "page.scroll")     return { ok: true };
        if (method === "page.evalJs")    return { type: "string", value: "hi" };
        if (method === "console.read")   return [{ ts: 1, level: "error", text: "boom" }];
        if (method === "network.read")   return [{ ts: 1, method: "GET", url: "https://a", type: "Document", status: 200, durationMs: 12 }];
        throw new Error("unexpected method " + method);
      }),
      isConnected: () => true,
    } as any,
  };
};

describe("tool adapters", () => {
  it("tabs_list forwards with empty params and returns the wire result", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    const result = await tools.tabs_list.handler({});
    expect(calls).toEqual([{ method: "tabs.list", params: {} }]);
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse((result.content[0] as any).text)).toEqual([
      { tabId: 1, url: "https://a", title: "a", active: true },
    ]);
  });

  it("tabs_create passes url through", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.tabs_create.handler({ url: "https://example.com" });
    expect(calls[0]).toEqual({
      method: "tabs.create",
      params: { url: "https://example.com", active: true },
    });
  });

  it("page_navigate auto-claims the tab (calls session.claim first)", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.page_navigate.handler({ tabId: 2, url: "https://example.com" });
    expect(calls.map((c) => c.method)).toEqual(["session.claim", "page.navigate"]);
  });

  it("fails fast when bridge has no extension", async () => {
    const { bridge } = fakeBridge();
    (bridge as any).isConnected = () => false;
    const tools = buildTools(bridge);
    await expect(tools.tabs_list.handler({})).rejects.toThrow(/extension/i);
  });

  it("tabs_create auto-claims the newly created tab", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.tabs_create.handler({ url: "https://example.com" });
    expect(calls.map((c) => c.method)).toEqual(["tabs.create", "session.claim"]);
    expect((calls[1]!.params as any).tabId).toBe(2);
  });

  it("page_snapshot auto-claims and forwards params", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.page_snapshot.handler({ tabId: 5 });
    expect(calls.map((c) => c.method)).toEqual(["session.claim", "page.snapshot"]);
  });

  it("page_screenshot returns base64 payload in a text content block", async () => {
    const { bridge } = fakeBridge();
    const tools = buildTools(bridge);
    const result = await tools.page_screenshot.handler({ tabId: 5 });
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.format).toBe("png");
    expect(typeof parsed.base64).toBe("string");
  });

  it("page_navigate does not re-claim an already-claimed tab", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.page_navigate.handler({ tabId: 5, url: "https://a" });
    await tools.page_navigate.handler({ tabId: 5, url: "https://b" });
    const methods = calls.map((c) => c.method);
    // Expected: session.claim once, then two page.navigate calls
    expect(methods).toEqual(["session.claim", "page.navigate", "page.navigate"]);
  });

  it("tabs_close does NOT auto-claim (no session.claim call)", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.tabs_close.handler({ tabId: 7 });
    expect(calls.map(c => c.method)).toEqual(["tabs.close"]);
  });

  it("tabs_activate does NOT auto-claim", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.tabs_activate.handler({ tabId: 7 });
    expect(calls.map(c => c.method)).toEqual(["tabs.activate"]);
  });

  it("session_release does NOT auto-claim", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.session_release.handler({ tabId: 7 });
    expect(calls.map(c => c.method)).toEqual(["session.release"]);
  });

  it("page_click auto-claims and forwards selector/button/scrollIntoView", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.page_click.handler({ tabId: 7, selector: "#go" });
    expect(calls.map(c => c.method)).toEqual(["session.claim", "page.click"]);
    expect((calls[1]!.params as any).selector).toBe("#go");
    expect((calls[1]!.params as any).button).toBe("left");
  });

  it("page_type auto-claims and forwards text + submit default", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.page_type.handler({ tabId: 7, selector: "#q", text: "hi" });
    expect(calls.map(c => c.method)).toEqual(["session.claim", "page.type"]);
    expect((calls[1]!.params as any).submit).toBe(false);
  });

  it("page_scroll auto-claims and forwards a selector scroll target", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.page_scroll.handler({ tabId: 7, selector: "#footer" });
    expect(calls.map(c => c.method)).toEqual(["session.claim", "page.scroll"]);
  });

  it("page_scroll rejects params with no scroll target", async () => {
    const { bridge } = fakeBridge();
    const tools = buildTools(bridge);
    await expect(tools.page_scroll.handler({ tabId: 7 } as any)).rejects.toThrow();
  });

  it("page_eval_js auto-claims and forwards the expression", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.page_eval_js.handler({ tabId: 7, expression: "1+1" });
    expect(calls.map(c => c.method)).toEqual(["session.claim", "page.evalJs"]);
    expect((calls[1]!.params as any).expression).toBe("1+1");
  });

  it("console_read does NOT auto-claim", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.console_read.handler({ tabId: 7 });
    expect(calls.map(c => c.method)).toEqual(["console.read"]);
  });

  it("network_read does NOT auto-claim", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = buildTools(bridge);
    await tools.network_read.handler({ tabId: 7 });
    expect(calls.map(c => c.method)).toEqual(["network.read"]);
  });

  it("console_read returns an array of entries in the text content block", async () => {
    const { bridge } = fakeBridge();
    const tools = buildTools(bridge);
    const result = await tools.console_read.handler({ tabId: 7 });
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed).toEqual([{ ts: 1, level: "error", text: "boom" }]);
  });
});
