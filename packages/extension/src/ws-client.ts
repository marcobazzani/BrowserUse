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

  constructor(private opts: WsClientOptions, private dispatcher: Dispatcher) {}

  start() {
    this.closedByUs = false;
    this.connect();
  }

  stop() {
    this.closedByUs = true;
    this.ws?.close();
  }

  private async connect() {
    const token = await this.opts.getToken();
    if (!token) {
      this.opts.onStatus("badToken");
      return;
    }
    this.opts.onStatus("connecting");
    this.ws = new WebSocket(this.opts.url);
    this.ws.addEventListener("open", () => {
      this.opts.onStatus("open");
      this.ws!.send(JSON.stringify({ type: "hello", token }));
      this.opts.onStatus("authed");
      this.attempt = 0;
    });
    this.ws.addEventListener("message", async (ev) => {
      let parsed: unknown;
      try { parsed = JSON.parse(ev.data as string); } catch { return; }
      const req = RpcRequestSchema.safeParse(parsed);
      if (!req.success) return;
      const resp = await this.dispatcher.handle(req.data);
      this.ws!.send(JSON.stringify(resp));
    });
    this.ws.addEventListener("close", (ev) => {
      this.opts.onStatus(ev.code === 4003 ? "badToken" : "closed");
      if (this.closedByUs) return;
      const delay = nextBackoffMs(this.attempt++);
      setTimeout(() => this.connect(), delay);
    });
  }
}
