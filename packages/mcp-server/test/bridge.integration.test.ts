import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { BridgeServer } from "../src/bridge.js";

describe("BridgeServer integration", () => {
  let server: BridgeServer;
  let port: number;

  beforeEach(async () => {
    server = new BridgeServer({ token: "secret-token", timeoutMs: 1000 });
    port = await server.listen(0); // 0 = random free port
  });

  afterEach(async () => {
    await server.close();
  });

  it("rejects a client that sends wrong token", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((r) => ws.once("open", () => r()));
    ws.send(JSON.stringify({ type: "hello", token: "WRONG" }));
    await new Promise<void>((r) => ws.once("close", () => r()));
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  it("accepts auth and round-trips a method call", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((r) => ws.once("open", () => r()));
    ws.send(JSON.stringify({ type: "hello", token: "secret-token" }));

    ws.on("message", (raw) => {
      const req = JSON.parse(raw.toString());
      if (req.method === "tabs.list") {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: [] }));
      }
    });

    // Wait for server to consider us authed, then call.
    await new Promise((r) => setTimeout(r, 50));
    const result = await server.call("tabs.list", {});
    expect(result).toEqual([]);
    ws.close();
  });

  it("errors when no extension is connected", async () => {
    await expect(server.call("tabs.list", {})).rejects.toThrow(/no extension connected/i);
  });
});
