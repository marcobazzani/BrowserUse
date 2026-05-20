import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { BridgeServer } from "../src/bridge.js";
import { buildTools } from "../src/tools.js";
import { WebSocketServerTransport } from "../src/ws-transport.js";

/**
 * End-to-end test of the hub/proxy architecture:
 *
 *   fake-extension  ←WS(hello)──────┐
 *                                    ├──▶  BridgeServer  ──▶ buildTools()
 *   fake-proxy      ←WS(mcp-proxy)──┘              │
 *                                                   ▼
 *                                              Server + WebSocketServerTransport
 *
 * The proxy sends MCP protocol frames (initialize, tools/list, tools/call)
 * wrapped as {type: "mcp-request", msg}; the hub's Server answers via the
 * transport which wraps responses as {type: "mcp-response", msg}. Tool
 * calls fan out through the bridge to the fake extension.
 */
describe("proxy end-to-end", () => {
  let hub: BridgeServer;
  let port: number;
  let extWs: WebSocket;
  let proxyWs: WebSocket;
  const extResponses = new Map<string, unknown>();

  // Track proxy → hub message IDs so we can await responses.
  const proxyPending = new Map<number | string, (msg: any) => void>();

  beforeEach(async () => {
    hub = new BridgeServer({ token: "secret-token", timeoutMs: 2000 });
    port = await hub.listen(0);

    // Wire up the proxy handler — same as runLeader in index.ts.
    hub.setProxyHandler((ws) => {
      const tools = buildTools(hub);
      const server = new Server(
        { name: "chromanche-test", version: "0.0.0" },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: Object.entries(tools).map(([name, t]) => ({
          name,
          description: t.description,
          inputSchema: zodToJsonSchema(t.inputSchema) as Record<string, unknown>,
        })),
      }));
      server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const t = (tools as Record<string, (typeof tools)[keyof typeof tools]>)[req.params.name];
        if (!t) throw new Error(`unknown tool ${req.params.name}`);
        type P = Parameters<NonNullable<typeof t>["handler"]>[0];
        return (t.handler as (p: P) => Promise<any>)(
          (req.params.arguments ?? {}) as P,
        );
      });
      const transport = new WebSocketServerTransport(ws as unknown as WebSocket);
      server.connect(transport).catch(() => { /* ignore */ });
    });

    // Connect fake extension (as if the user's Chrome).
    extWs = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((r) => extWs.once("open", () => r()));
    extWs.send(JSON.stringify({ type: "hello", token: "secret-token", profile: "test-profile", label: "Test" }));
    extWs.on("message", (raw) => {
      const req = JSON.parse(raw.toString());
      if (!req.method) return;
      const r = extResponses.get(req.method);
      extWs.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: r ?? { ok: true } }));
    });
    await vi.waitFor(() => { if (!hub.isConnected()) throw new Error("ext not authed"); });

    // Connect fake proxy (as if a follower Claude Code session's stdio → WS shim).
    proxyWs = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((r) => proxyWs.once("open", () => r()));
    proxyWs.send(JSON.stringify({ type: "mcp-proxy-hello", token: "secret-token" }));
    proxyWs.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type !== "mcp-response" || !frame.msg) return;
      const id = frame.msg.id;
      if (id !== undefined) {
        const resolve = proxyPending.get(id);
        if (resolve) { proxyPending.delete(id); resolve(frame.msg); }
      }
    });
  });

  afterEach(async () => {
    try { proxyWs?.close(); } catch { /* ignore */ }
    try { extWs?.close(); } catch { /* ignore */ }
    await hub.close();
    proxyPending.clear();
    extResponses.clear();
  });

  /** Send an MCP JSON-RPC request as a proxy frame, await the matching response. */
  async function proxyRpc<T = any>(method: string, params: unknown): Promise<T> {
    const id = Math.floor(Math.random() * 1_000_000);
    const msg = { jsonrpc: "2.0", id, method, params };
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => { proxyPending.delete(id); reject(new Error(`proxy rpc ${method} timed out`)); }, 3000);
      proxyPending.set(id, (resp) => { clearTimeout(t); resolve(resp as T); });
      proxyWs.send(JSON.stringify({ type: "mcp-request", msg }));
    });
  }

  it("initialize round-trips through the proxy → hub → MCP Server pipeline", async () => {
    const resp = await proxyRpc<any>("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test-proxy", version: "0.0.0" },
    });
    expect(resp.result?.serverInfo?.name).toBe("chromanche-test");
  });

  it("tools/list returns the full tool catalog via the proxy", async () => {
    // Must complete initialize first per MCP protocol.
    await proxyRpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test-proxy", version: "0.0.0" },
    });
    const resp = await proxyRpc<any>("tools/list", {});
    const names: string[] = resp.result.tools.map((t: any) => t.name);
    expect(names).toContain("chromanche_list_profiles");
    expect(names).toContain("page_snapshot");
    expect(names).toContain("tabs_list");
  });

  it("tools/call routes to the fake extension through the bridge", async () => {
    await proxyRpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test-proxy", version: "0.0.0" },
    });
    extResponses.set("tabs.list", [
      { tabId: 1, url: "https://a", title: "a", active: true },
    ]);
    const resp = await proxyRpc<any>("tools/call", {
      name: "tabs_list",
      arguments: { profile: "test-profile" },
    });
    // Result.content[0].text is the JSON-stringified bridge response.
    const payload = JSON.parse(resp.result.content[0].text);
    expect(payload).toEqual([{ tabId: 1, url: "https://a", title: "a", active: true }]);
  });

  it("concurrent proxy sessions have independent claim caches", async () => {
    // Connect a second proxy, modeling two Claude Code sessions to one hub.
    const proxyWs2 = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((r) => proxyWs2.once("open", () => r()));
    proxyWs2.send(JSON.stringify({ type: "mcp-proxy-hello", token: "secret-token" }));

    const proxy2Pending = new Map<number | string, (msg: any) => void>();
    proxyWs2.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type !== "mcp-response" || !frame.msg) return;
      const id = frame.msg.id;
      const resolve = proxy2Pending.get(id);
      if (resolve) { proxy2Pending.delete(id); resolve(frame.msg); }
    });

    function rpc2<T = any>(method: string, params: unknown): Promise<T> {
      const id = Math.floor(Math.random() * 1_000_000);
      const msg = { jsonrpc: "2.0", id, method, params };
      return new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => { proxy2Pending.delete(id); reject(new Error(`p2 ${method} timed out`)); }, 3000);
        proxy2Pending.set(id, (r) => { clearTimeout(t); resolve(r as T); });
        proxyWs2.send(JSON.stringify({ type: "mcp-request", msg }));
      });
    }

    await proxyRpc("initialize", {
      protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "p1", version: "0" },
    });
    await rpc2("initialize", {
      protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "p2", version: "0" },
    });

    // Count how many session.claim calls the fake extension sees.
    let claimCount = 0;
    extWs.removeAllListeners("message");
    extWs.on("message", (raw) => {
      const req = JSON.parse(raw.toString());
      if (!req.method) return;
      if (req.method === "session.claim") claimCount++;
      extWs.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: req.method === "session.claim" ? { ok: true, groupId: 1 } : { ok: true } }));
    });

    // Both proxies click the SAME tabId. Each has its own buildTools() instance
    // so each must claim independently — expected claimCount = 2.
    await proxyRpc("tools/call", {
      name: "page_click",
      arguments: { tabId: 5, uid: "e1", profile: "test-profile" },
    });
    await rpc2("tools/call", {
      name: "page_click",
      arguments: { tabId: 5, uid: "e1", profile: "test-profile" },
    });
    expect(claimCount).toBe(2);

    proxyWs2.close();
  });
});
