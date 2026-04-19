import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServerTransport } from "../src/ws-transport.js";

/**
 * Spin up a real WSServer + a pair of connected sockets so the transport
 * exercises actual ws event plumbing. Avoids mocking ws internals.
 */
async function connectedPair(): Promise<{
  wss: WebSocketServer;
  serverWs: WebSocket;   // the socket the transport wraps on the hub side
  clientWs: WebSocket;   // the fake proxy side — use this to send test frames
  close: () => Promise<void>;
}> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const { port } = wss.address() as { port: number };

  const clientWs = new WebSocket(`ws://127.0.0.1:${port}`);
  const serverWs = await new Promise<WebSocket>((resolve) => {
    wss.once("connection", (ws) => resolve(ws as unknown as WebSocket));
  });
  await new Promise<void>((r) => (clientWs.readyState === WebSocket.OPEN ? r() : clientWs.once("open", () => r())));

  return {
    wss,
    serverWs,
    clientWs,
    close: async () => {
      try { clientWs.close(); } catch { /* ignore */ }
      try { serverWs.close(); } catch { /* ignore */ }
      await new Promise<void>((r) => wss.close(() => r()));
    },
  };
}

describe("WebSocketServerTransport", () => {
  let pair: Awaited<ReturnType<typeof connectedPair>>;

  beforeEach(async () => {
    pair = await connectedPair();
  });
  afterEach(async () => {
    await pair.close();
  });

  it("fires onmessage only for mcp-request frames", async () => {
    const transport = new WebSocketServerTransport(pair.serverWs);
    const onmessage = vi.fn();
    transport.onmessage = onmessage;
    await transport.start();

    // Non-MCP frame — should be ignored.
    pair.clientWs.send(JSON.stringify({ type: "ping" }));
    // Malformed JSON — onerror, not onmessage.
    pair.clientWs.send("not json");
    // mcp-proxy-hello after handoff — also ignored.
    pair.clientWs.send(JSON.stringify({ type: "mcp-proxy-hello", token: "x" }));
    // Real mcp-request.
    const body: JSONRPCMessage = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    pair.clientWs.send(JSON.stringify({ type: "mcp-request", msg: body }));

    await vi.waitFor(() => expect(onmessage).toHaveBeenCalledTimes(1));
    expect(onmessage).toHaveBeenCalledWith(body);
  });

  it("wraps send() output in mcp-response frames", async () => {
    const transport = new WebSocketServerTransport(pair.serverWs);
    await transport.start();

    const received: unknown[] = [];
    pair.clientWs.on("message", (raw) => received.push(JSON.parse(raw.toString())));

    const body: JSONRPCMessage = { jsonrpc: "2.0", id: 42, result: { ok: true } };
    await transport.send(body);

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toEqual({ type: "mcp-response", msg: body });
  });

  it("fires onerror on malformed JSON without crashing", async () => {
    const transport = new WebSocketServerTransport(pair.serverWs);
    const onerror = vi.fn();
    const onmessage = vi.fn();
    transport.onerror = onerror;
    transport.onmessage = onmessage;
    await transport.start();

    pair.clientWs.send("{ not valid json");

    await vi.waitFor(() => expect(onerror).toHaveBeenCalled());
    expect(onmessage).not.toHaveBeenCalled();
  });

  it("fires onclose when the underlying socket closes", async () => {
    const transport = new WebSocketServerTransport(pair.serverWs);
    const onclose = vi.fn();
    transport.onclose = onclose;
    await transport.start();

    pair.clientWs.close();
    await vi.waitFor(() => expect(onclose).toHaveBeenCalled());
  });

  it("close() closes the underlying socket", async () => {
    const transport = new WebSocketServerTransport(pair.serverWs);
    await transport.start();
    await transport.close();
    // Give the close frame a tick to propagate.
    await vi.waitFor(() => expect(pair.serverWs.readyState).toBe(WebSocket.CLOSED));
  });

  it("send() is a no-op if the socket is not OPEN (no throw)", async () => {
    pair.serverWs.close();
    await vi.waitFor(() => expect(pair.serverWs.readyState).toBe(WebSocket.CLOSED));

    const transport = new WebSocketServerTransport(pair.serverWs);
    await transport.start();

    await expect(transport.send({ jsonrpc: "2.0", id: 1, result: null })).resolves.toBeUndefined();
  });

  it("start() is idempotent — second call does not duplicate listeners", async () => {
    const transport = new WebSocketServerTransport(pair.serverWs);
    const onmessage = vi.fn();
    transport.onmessage = onmessage;
    await transport.start();
    await transport.start();

    const body: JSONRPCMessage = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    pair.clientWs.send(JSON.stringify({ type: "mcp-request", msg: body }));

    await vi.waitFor(() => expect(onmessage).toHaveBeenCalled());
    expect(onmessage).toHaveBeenCalledTimes(1);
  });
});
