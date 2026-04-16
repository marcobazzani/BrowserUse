import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  ClientHelloSchema,
  RpcRequestSchema,
  RpcResponseSchema,
  type RpcResponse,
} from "@browseruse/shared";

export interface Correlator {
  register<T = unknown>(id: number): Promise<T>;
  resolve(resp: RpcResponse): void;
  rejectAll(err: Error): void;
}

export function createCorrelator(opts: { timeoutMs: number }): Correlator {
  const pending = new Map<
    number | string,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  return {
    register<T>(id: number) {
      return new Promise<T>((resolve, reject) => {
        const prev = pending.get(id);
        if (prev) {
          clearTimeout(prev.timer);
          prev.reject(new Error(`id ${id} reused before previous request resolved`));
          pending.delete(id);
        }
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`request ${id} timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs);
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      });
    },
    resolve(resp: RpcResponse) {
      const entry = pending.get(resp.id);
      if (!entry) return; // unknown id → drop silently
      clearTimeout(entry.timer);
      pending.delete(resp.id);
      if (resp.error) entry.reject(new Error(resp.error.message));
      else entry.resolve(resp.result);
    },
    rejectAll(err: Error) {
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(err);
      }
      pending.clear();
    },
  };
}

export class BridgeServer {
  private wss?: WebSocketServer;
  private authed?: WebSocket;
  private corr: Correlator;
  private nextId = 1;
  private token: string;
  private timeoutMs: number;

  constructor(opts: { token: string; timeoutMs: number }) {
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs;
    this.corr = createCorrelator({ timeoutMs: opts.timeoutMs });
  }

  async listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ host: "127.0.0.1", port });
      const onStartupError = (err: Error) => reject(err);
      this.wss.once("listening", () => {
        this.wss!.off("error", onStartupError);
        const addr = this.wss!.address();
        if (typeof addr === "object" && addr) resolve(addr.port);
        else reject(new Error("failed to bind"));
      });
      this.wss.on("connection", (ws) => this.onConnection(ws));
      this.wss.once("error", onStartupError);
      this.wss.on("error", (err) => {
        console.error("[browseruse] wss error:", err);
      });
    });
  }

  private onConnection(ws: WebSocket) {
    let authed = false;
    const authTimer = setTimeout(() => {
      if (!authed) ws.close(4001, "auth timeout");
    }, 3000);

    ws.on("message", (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        ws.close(4002, "bad json");
        return;
      }
      if (!authed) {
        const hello = ClientHelloSchema.safeParse(parsed);
        if (!hello.success) {
          ws.close(4003, "bad token");
          return;
        }
        const expected = Buffer.from(this.token, "utf8");
        const actual = Buffer.from(hello.data.token, "utf8");
        const match =
          expected.length === actual.length && timingSafeEqual(expected, actual);
        if (!match) {
          ws.close(4003, "bad token");
          return;
        }
        authed = true;
        clearTimeout(authTimer);
        this.authed = ws;
        return;
      }
      // After auth: incoming frames are responses to our requests.
      const resp = RpcResponseSchema.safeParse(parsed);
      if (resp.success) this.corr.resolve(resp.data);
    });

    ws.on("close", () => {
      if (this.authed === ws) {
        this.authed = undefined;
        this.corr.rejectAll(new Error("extension disconnected"));
      }
    });
  }

  async call<T = unknown>(method: string, params: unknown): Promise<T> {
    if (!this.authed || this.authed.readyState !== WebSocket.OPEN) {
      throw new Error("no extension connected");
    }
    const id = this.nextId++;
    const req = { jsonrpc: "2.0" as const, id, method, params };
    // Validate we're sending a well-formed request envelope.
    RpcRequestSchema.parse(req);
    this.authed.send(JSON.stringify(req));
    return this.corr.register<T>(id);
  }

  isConnected(): boolean {
    return !!this.authed && this.authed.readyState === WebSocket.OPEN;
  }

  async close(): Promise<void> {
    this.corr.rejectAll(new Error("bridge closing"));
    if (!this.wss) return;
    const wss = this.wss;
    this.wss = undefined;
    await new Promise<void>((r) => wss.close(() => r()));
  }
}
