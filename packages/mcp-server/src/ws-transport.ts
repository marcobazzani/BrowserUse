import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { WebSocket } from "ws";

/**
 * Hub-side transport: wraps a single proxy's WebSocket so a Server instance
 * can speak MCP over it. Frames are {type: "mcp-request"|"mcp-response", msg}.
 * The proxy handshake (mcp-proxy-hello) is the hub's responsibility — by the
 * time this transport is constructed, auth is already complete.
 */
export class WebSocketServerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private started = false;

  constructor(private ws: WebSocket) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.ws.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch (e) {
        this.onerror?.(e as Error);
        return;
      }
      if (parsed && typeof parsed === "object") {
        const frame = parsed as { type?: unknown; msg?: unknown };
        if (frame.type === "mcp-request" && frame.msg) {
          this.onmessage?.(frame.msg as JSONRPCMessage);
        }
        // Other frame types (mcp-proxy-hello already consumed, or stray pings)
        // are ignored.
      }
    });
    this.ws.on("close", () => this.onclose?.());
    this.ws.on("error", (err) => this.onerror?.(err as Error));
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.ws.readyState !== 1 /* OPEN */) return;
    this.ws.send(JSON.stringify({ type: "mcp-response", msg: message }));
  }

  async close(): Promise<void> {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}
