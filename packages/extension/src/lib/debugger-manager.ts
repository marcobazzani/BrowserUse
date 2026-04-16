export interface ConsoleEntry {
  ts: number;
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string;
}

export interface NetworkEntry {
  ts: number;
  method: string;
  url: string;
  status?: number;
  durationMs?: number;
  type: string;
}

export interface ReadFilter {
  pattern?: RegExp;
  since?: number;
  limit: number;
}

export class RingBuffer<T extends { ts: number }> {
  private items: T[] = [];
  constructor(private cap = 500) {}

  push(e: T): void {
    this.items.push(e);
    if (this.items.length > this.cap) {
      this.items.splice(0, this.items.length - this.cap);
    }
  }

  read(filter: ReadFilter, extract: (t: T) => string): T[] {
    return this.items
      .filter((i) => filter.since === undefined || i.ts > filter.since)
      .filter((i) => !filter.pattern || filter.pattern.test(extract(i)))
      .slice(-filter.limit);
  }

  size(): number {
    return this.items.length;
  }
}

type InflightRequest = { start: number; method: string; url: string; type: string };

export class DebuggerManager {
  private consoles = new Map<number, RingBuffer<ConsoleEntry>>();
  private networks = new Map<number, RingBuffer<NetworkEntry>>();
  private attached = new Set<number>();
  private inflight = new Map<string, InflightRequest>();

  constructor() {
    chrome.tabs.onRemoved.addListener((tabId) => { void this.detach(tabId); });
    chrome.debugger.onEvent.addListener((src, method, params) =>
      this.onEvent(src, method, params as Record<string, unknown>)
    );
    chrome.debugger.onDetach.addListener((source) => {
      if (source.tabId !== undefined) {
        this.attached.delete(source.tabId);
        // Keep buffers — user may still want to read history post-detach; next attach resets them.
      }
    });
  }

  async attach(tabId: number): Promise<void> {
    if (this.attached.has(tabId)) return;
    await chrome.debugger.attach({ tabId }, "1.3");
    await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
    await chrome.debugger.sendCommand({ tabId }, "Network.enable");
    this.consoles.set(tabId, new RingBuffer());
    this.networks.set(tabId, new RingBuffer());
    this.attached.add(tabId);
  }

  async detach(tabId: number): Promise<void> {
    if (!this.attached.has(tabId)) return;
    await chrome.debugger.detach({ tabId }).catch(() => {});
    this.attached.delete(tabId);
    this.consoles.delete(tabId);
    this.networks.delete(tabId);
  }

  async sendCommand<T = unknown>(tabId: number, method: string, params: unknown): Promise<T> {
    await this.attach(tabId);
    try {
      return (await chrome.debugger.sendCommand({ tabId }, method, params as object)) as T;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/not attached/i.test(msg)) throw e;
      // Chrome detached us (navigation, reload). Clear state and retry once.
      this.attached.delete(tabId);
      await this.attach(tabId);
      return (await chrome.debugger.sendCommand({ tabId }, method, params as object)) as T;
    }
  }

  readConsole(tabId: number, pattern?: string, since?: number, limit = 500): ConsoleEntry[] {
    const buf = this.consoles.get(tabId);
    if (!buf) return [];
    const re = pattern ? new RegExp(pattern) : undefined;
    return buf.read({ pattern: re, since, limit }, (e) => e.text);
  }

  readNetwork(tabId: number, pattern?: string, since?: number, limit = 500): NetworkEntry[] {
    const buf = this.networks.get(tabId);
    if (!buf) return [];
    const re = pattern ? new RegExp(pattern) : undefined;
    return buf.read({ pattern: re, since, limit }, (e) => e.url);
  }

  /** Exposed for tests. */
  onEvent(src: chrome.debugger.Debuggee, method: string, params: Record<string, unknown>): void {
    const tabId = src.tabId;
    if (tabId === undefined) return;
    const consoleBuf = this.consoles.get(tabId);
    const netBuf = this.networks.get(tabId);

    if (method === "Runtime.consoleAPICalled" && consoleBuf) {
      const level = ((params.type as string) ?? "log") as ConsoleEntry["level"];
      const args = (params.args ?? []) as Array<{ value?: unknown; description?: string }>;
      const text = args.map((a) => String(a.value ?? a.description ?? "")).join(" ").slice(0, 2000);
      consoleBuf.push({ ts: Date.now(), level, text });
    } else if (method === "Runtime.exceptionThrown" && consoleBuf) {
      const text = ((params.exceptionDetails as Record<string, unknown> | undefined)?.text as string) ?? "exception";
      consoleBuf.push({ ts: Date.now(), level: "error", text });
    } else if (method === "Network.requestWillBeSent" && netBuf) {
      const req = (params.request as { method?: string; url?: string }) ?? {};
      this.inflight.set(params.requestId as string, {
        start: Date.now(),
        method: req.method ?? "GET",
        url: req.url ?? "",
        type: (params.type as string) ?? "Other",
      });
    } else if (method === "Network.responseReceived" && netBuf) {
      const cur = this.inflight.get(params.requestId as string);
      if (cur) {
        const resp = (params.response as { status?: number }) ?? {};
        netBuf.push({
          ts: Date.now(),
          method: cur.method,
          url: cur.url,
          status: resp.status,
          durationMs: Date.now() - cur.start,
          type: cur.type,
        });
        this.inflight.delete(params.requestId as string);
      }
    }
  }
}
