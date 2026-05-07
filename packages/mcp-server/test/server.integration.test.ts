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
        "page.hover": { ok: true },
        "page.focus": { ok: true, focused: true, modeUsed: "js" },
        "page.pressKey": { ok: true },
        "page.fillForm": { ok: true, filledCount: 1 },
        "page.handleDialog": { ok: true, handled: true },
        "page.select": { ok: true, selected: [] },
        "page.uploadFile": { ok: true, uploadedCount: 0 },
        "page.drag": { ok: true },
        "session.claim": { ok: true, groupId: 5 },
        "session.release": { ok: true },
        "page.evalJs":   { type: "string", value: "hi" },
        "console.read":  [{ ts: 1, level: "error", text: "boom" }],
        "network.read":  [{ ts: 1, method: "GET", url: "https://a", type: "Document", status: 200, durationMs: 12 }],
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

  it("console_read round-trips an array through the real bridge", async () => {
    const tools = buildTools(server);
    const result = await tools.console_read.handler({ tabId: 1 });
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].level).toBe("error");
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

  it("page_batch runs click + type + screenshot in one MCP call over the real bridge", async () => {
    const seen: string[] = [];
    ws.removeAllListeners("message");
    ws.on("message", (raw) => {
      const req = JSON.parse(raw.toString());
      seen.push(req.method);
      const responders: Record<string, unknown> = {
        "session.claim":   { ok: true, groupId: 5 },
        "page.click":      { ok: true },
        "page.type":       { ok: true },
        "page.screenshot": { format: "png", base64: "AAAA" },
      };
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: responders[req.method] }));
    });
    const tools = buildTools(server);
    const r = await tools.page_batch.handler({
      steps: [
        { tool: "page_click", args: { tabId: 1, uid: "e5" } },
        { tool: "page_type",  args: { tabId: 1, uid: "e6", text: "Alice\t30\nBob\t25" } },
        { tool: "page_screenshot", args: { tabId: 1 } },
      ],
    });
    const parsed = JSON.parse((r.content[0] as any).text) as {
      ok: boolean;
      results: Array<{ tool: string; ok: boolean; result?: unknown }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.results.map((s) => s.tool)).toEqual(["page_click", "page_type", "page_screenshot"]);
    expect(parsed.results.every((s) => s.ok)).toBe(true);
    // Wire methods reached the fake extension exactly once each (claim is shared).
    void parsed;
    expect(seen.filter((m) => m === "page.click").length).toBe(1);
    expect(seen.filter((m) => m === "page.type").length).toBe(1);
    expect(seen.filter((m) => m === "page.screenshot").length).toBe(1);
    // Inside a batch, the screenshot's image content is elided with a sentinel
    // so the batch result stays small. Metadata (format, byteLength) survives.
    const shotResult = parsed.results[2]!.result as { format: string; image: string; byteLength: number };
    expect(shotResult.format).toBe("png");
    expect(shotResult.image).toMatch(/elided/i);
    expect(shotResult.byteLength).toBe(4);
  });

  it("page_batch with stopOnError=false collects per-step errors and keeps running", async () => {
    const seen: string[] = [];
    ws.removeAllListeners("message");
    ws.on("message", (raw) => {
      const req = JSON.parse(raw.toString());
      seen.push(req.method);
      if (req.method === "page.type") {
        ws.send(JSON.stringify({
          jsonrpc: "2.0", id: req.id,
          error: { code: -32000, message: "uid not resolved" },
        }));
        return;
      }
      const responders: Record<string, unknown> = {
        "session.claim":   { ok: true, groupId: 5 },
        "page.click":      { ok: true },
        "page.screenshot": { format: "png", base64: "AAAA" },
      };
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: responders[req.method] }));
    });
    const tools = buildTools(server);
    const r = await tools.page_batch.handler({
      stopOnError: false,
      steps: [
        { tool: "page_click", args: { tabId: 1, uid: "e5" } },
        { tool: "page_type",  args: { tabId: 1, uid: "e_bad", text: "x" } },
        { tool: "page_screenshot", args: { tabId: 1 } },
      ],
    });
    const parsed = JSON.parse((r.content[0] as any).text) as {
      ok: boolean;
      results: Array<{ tool: string; ok: boolean; error?: string }>;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.results.map((s) => s.ok)).toEqual([true, false, true]);
    expect(parsed.results[1]!.error).toMatch(/uid not resolved/);
    // The third step ran even though the second failed.
    expect(seen).toContain("page.screenshot");
  });
});
