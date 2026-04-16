import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTools, _resetClaimedForTest } from "../src/tools.js";

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
        throw new Error("unexpected method " + method);
      }),
      isConnected: () => true,
    } as any,
  };
};

describe("tool adapters", () => {
  beforeEach(() => { _resetClaimedForTest(); });

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
});
