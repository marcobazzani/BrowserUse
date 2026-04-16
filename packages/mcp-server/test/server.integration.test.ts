import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { BridgeServer } from "../src/bridge.js";
import { buildTools } from "../src/tools.js";

describe("server end-to-end (no stdio transport; tools driven directly)", () => {
  let server: BridgeServer;
  let port: number;
  let ws: WebSocket;

  beforeEach(async () => {
    server = new BridgeServer({ token: "T12345678", timeoutMs: 2000 });
    port = await server.listen(0);
    ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((r) => ws.once("open", () => r()));
    ws.send(JSON.stringify({ type: "hello", token: "T12345678" }));
    // Fake extension: reply to every method.
    ws.on("message", (raw) => {
      const req = JSON.parse(raw.toString());
      const responders: Record<string, unknown> = {
        "tabs.list": [{ tabId: 1, url: "https://a", title: "a", active: true }],
        "tabs.create": { tabId: 99, url: req.params.url, title: "", active: true },
        "tabs.close": { ok: true },
        "tabs.activate": { ok: true },
        "page.navigate": { ok: true, finalUrl: req.params.url },
        "page.snapshot": { mode: "text", url: "https://a", title: "a", content: "hello", truncated: false },
        "page.screenshot": { format: "png", base64: "AAAA" },
        "page.click": { ok: true },
        "page.type": { ok: true },
        "page.scroll": { ok: true },
        "session.claim": { ok: true, groupId: 5 },
        "session.release": { ok: true },
      };
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: responders[req.method] }));
    });
    // Poll rather than sleep.
    const start = Date.now();
    while (!server.isConnected()) {
      if (Date.now() - start > 2000) throw new Error("timed out waiting for auth");
      await new Promise((r) => setTimeout(r, 10));
    }
  });

  afterEach(async () => {
    ws.removeAllListeners("message");
    ws.close();
    await server.close();
  });

  it("tabs_list round-trips through the real bridge", async () => {
    const tools = buildTools(server);
    const result = await tools.tabs_list.handler({});
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed[0].url).toBe("https://a");
  });

  it("page_snapshot round-trips through the real bridge", async () => {
    const tools = buildTools(server);
    const result = await tools.page_snapshot.handler({ tabId: 7 });
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.content).toBe("hello");
    expect(parsed.mode).toBe("text");
  });

  it("page_click auto-claims via session.claim then clicks", async () => {
    const seen: string[] = [];
    ws.removeAllListeners("message");
    ws.on("message", (raw) => {
      const req = JSON.parse(raw.toString());
      seen.push(req.method);
      const r: Record<string, unknown> = {
        "session.claim": { ok: true, groupId: 5 },
        "page.click": { ok: true },
      };
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: r[req.method] }));
    });
    const tools = buildTools(server);
    await tools.page_click.handler({ tabId: 1, selector: "#go" });
    expect(seen).toEqual(["session.claim", "page.click"]);
  });

  it("page_navigate auto-claims via session.claim then navigates", async () => {
    const seen: string[] = [];
    ws.removeAllListeners("message");
    ws.on("message", (raw) => {
      const req = JSON.parse(raw.toString());
      seen.push(req.method);
      const responders: Record<string, unknown> = {
        "session.claim": { ok: true, groupId: 5 },
        "page.navigate": { ok: true, finalUrl: req.params.url },
      };
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: responders[req.method] }));
    });
    const tools = buildTools(server);
    await tools.page_navigate.handler({ tabId: 1, url: "https://example.com" });
    expect(seen).toEqual(["session.claim", "page.navigate"]);
  });
});
