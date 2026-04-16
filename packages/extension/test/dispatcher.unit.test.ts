import { describe, expect, it } from "vitest";
import { Dispatcher } from "../src/dispatcher.js";

describe("Dispatcher", () => {
  it("routes request to the registered handler and wraps the response", async () => {
    const d = new Dispatcher();
    d.register("tabs.list", async () => [{ tabId: 1, url: "https://x", title: "x", active: true }]);
    const resp = await d.handle({ jsonrpc: "2.0", id: 1, method: "tabs.list", params: {} });
    expect(resp).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: [{ tabId: 1, url: "https://x", title: "x", active: true }],
    });
  });

  it("returns a JSON-RPC error envelope when handler throws", async () => {
    const d = new Dispatcher();
    d.register("boom", async () => { throw new Error("nope"); });
    const resp = await d.handle({ jsonrpc: "2.0", id: 2, method: "boom" });
    expect(resp.error?.message).toBe("nope");
  });

  it("returns method-not-found for unknown methods", async () => {
    const d = new Dispatcher();
    const resp = await d.handle({ jsonrpc: "2.0", id: 3, method: "mystery" });
    expect(resp.error?.code).toBe(-32601);
  });
});
