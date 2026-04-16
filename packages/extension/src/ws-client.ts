import type { Dispatcher } from "./dispatcher.js";
import { RpcRequestSchema } from "@browseruse/shared";

export function nextBackoffMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 30_000);
}

export interface WsClientOptions {
  url: string;
  getToken: () => Promise<string | null>;
  onStatus: (status: "connecting" | "open" | "authed" | "closed" | "badToken") => void;
}

export class WsClient {
  private ws?: WebSocket;
  private attempt = 0;
  private closedByUs = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  constructor(private opts: WsClientOptions, private dispatcher: Dispatcher) {}

  start() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.closedByUs = false;
    this.connect();
  }

  stop() {
    this.closedByUs = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.ws?.close();
  }

  private async connect() {
    const token = await this.opts.getToken();
    if (!token) {
      this.opts.onStatus("badToken");
      return;
    }
    // If a previous socket is still lingering (e.g. stop() + start() in quick
    // succession), disown it BEFORE calling close() so its close handler sees
    // this.ws !== ws and skips reconnection-scheduling.
    if (this.ws) {
      const stale = this.ws;
      this.ws = undefined;
      try { stale.close(); } catch { /* ignore */ }
    }
    this.opts.onStatus("connecting");
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;
    // All listeners capture `ws` locally so a late `open` event from a stale
    // socket can't send on the replacement socket (which may still be CONNECTING).
    ws.addEventListener("open", () => {
      if (this.ws !== ws) return; // stale socket — ignore
      if (ws.readyState !== WebSocket.OPEN) return;
      this.opts.onStatus("open");
      try {
        ws.send(JSON.stringify({ type: "hello", token }));
      } catch {
        // racing close → let the close handler drive reconnect
        return;
      }
      this.opts.onStatus("authed");
      this.attempt = 0;
    });
    ws.addEventListener("message", async (ev) => {
      if (this.ws !== ws) return;
      let parsed: unknown;
      try { parsed = JSON.parse(ev.data as string); } catch { return; }
      const req = RpcRequestSchema.safeParse(parsed);
      if (!req.success) return;
      const resp = await this.dispatcher.handle(req.data);
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify(resp)); } catch { /* ignore */ }
      }
    });
    ws.addEventListener("close", (ev) => {
      // Only the active socket's close drives reconnect.
      const isActive = this.ws === ws;
      if (isActive) this.opts.onStatus(ev.code === 4003 ? "badToken" : "closed");
      if (!isActive || this.closedByUs) return;
      const delay = nextBackoffMs(this.attempt++);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        this.connect();
      }, delay);
    });
    ws.addEventListener("error", () => { /* swallow; close will follow */ });
  }
}
