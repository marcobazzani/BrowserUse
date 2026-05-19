import WebSocket from "ws";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";

/**
 * Follower role: forward stdio MCP ↔ hub's WS. No port binding, no tool logic.
 * Each JSON-RPC frame from Claude Code becomes an "mcp-request" WS frame to
 * the hub; responses come back as "mcp-response" frames and get written to
 * stdout.
 *
 * On hub disconnect, reconnect with exponential backoff up to ~30s. If the
 * hub stays down past the retry budget, the proxy exits with a clear error
 * so the parent Claude Code session falls back to "no MCP connection"
 * rather than silently hanging.
 */
export async function runProxy(cfg: Config): Promise<void> {
  const url = `ws://127.0.0.1:${cfg.port}`;

  // stdio transport: we use its framing (Content-Length headers) but not its
  // Server wiring. onmessage delivers parsed JSON-RPC bodies from stdin;
  // send() writes a framed body to stdout.
  const stdio = new StdioServerTransport();
  let ws: WebSocket | undefined;
  let connected = false;
  let pending: JSONRPCMessage[] = [];
  let attempt = 0;
  let closedByUs = false;

  const backoffMs = () => Math.min(500 * 2 ** attempt, 30_000);

  const connect = (): void => {
    if (closedByUs) return;
    const next = new WebSocket(url);
    ws = next;

    next.on("open", () => {
      if (ws !== next) return;
      next.send(JSON.stringify({ type: "mcp-proxy-hello", token: cfg.token }));
      connected = true;
      attempt = 0;
      // Flush anything the model sent before we were connected.
      for (const msg of pending) {
        try { next.send(JSON.stringify({ type: "mcp-request", msg })); } catch { /* ignore */ }
      }
      pending = [];
    });

    next.on("message", (data) => {
      if (ws !== next) return;
      let parsed: unknown;
      try { parsed = JSON.parse(data.toString()); } catch { return; }
      if (parsed && typeof parsed === "object") {
        const frame = parsed as { type?: unknown; msg?: unknown };
        if (frame.type === "mcp-response" && frame.msg) {
          stdio.send(frame.msg as JSONRPCMessage).catch((err) =>
            console.error("[chromanche-proxy] stdio send error:", err),
          );
        }
      }
    });

    const scheduleReconnect = () => {
      if (closedByUs) return;
      const delay = backoffMs();
      attempt += 1;
      if (delay >= 30_000 && attempt > 8) {
        console.error(
          `[chromanche-proxy] hub at ${url} has been unavailable for too long — exiting so Claude Code surfaces the disconnect.`,
        );
        process.exit(1);
      }
      setTimeout(connect, delay);
    };

    next.on("close", () => {
      if (ws !== next) return;
      connected = false;
      ws = undefined;
      scheduleReconnect();
    });

    next.on("error", (err) => {
      if (ws !== next) return;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ECONNREFUSED") {
        console.error("[chromanche-proxy] ws error:", err);
      }
      // close handler will schedule reconnect
    });
  };

  stdio.onmessage = (msg) => {
    if (connected && ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: "mcp-request", msg })); } catch { /* ignore */ }
    } else {
      // Buffer until we reconnect. Claude Code has a per-request timeout
      // anyway, so unbounded buffering isn't a concern in practice.
      pending.push(msg);
    }
  };

  await stdio.start();
  connect();

  const shutdown = () => {
    closedByUs = true;
    try { ws?.close(); } catch { /* ignore */ }
    stdio.close().catch(() => { /* ignore */ })
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
