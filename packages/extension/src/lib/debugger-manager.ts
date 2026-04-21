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

export interface PendingDialog {
  type: string;        // "alert" | "confirm" | "prompt" | "beforeunload"
  message: string;
  defaultPrompt?: string;
  url?: string;
}

export interface FrameTargetInfo {
  targetId: string;
  url: string;
}

export class DebuggerManager {
  private consoles = new Map<number, RingBuffer<ConsoleEntry>>();
  private networks = new Map<number, RingBuffer<NetworkEntry>>();
  private attached = new Set<number>();
  private inflight = new Map<string, InflightRequest>();
  private pendingDialogs = new Map<number, PendingDialog>();
  // For cross-origin (OOPIF) iframes, Chromium spins up a separate CDP target.
  // We attach a debuggee per frame target so a11y/DOM/Runtime calls can reach
  // content inside those frames. Key is tabId → map of frame targetId → info.
  private frameTargets = new Map<number, Map<string, FrameTargetInfo>>();

  constructor() {
    chrome.tabs.onRemoved.addListener((tabId) => { void this.detach(tabId); });
    chrome.debugger.onEvent.addListener((src, method, params) =>
      this.onEvent(src, method, params as Record<string, unknown>)
    );
    chrome.debugger.onDetach.addListener((source) => {
      if (source.tabId !== undefined) {
        this.attached.delete(source.tabId);
        this.pendingDialogs.delete(source.tabId);
        const frames = this.frameTargets.get(source.tabId);
        if (frames) {
          for (const id of frames.keys()) {
            void chrome.debugger.detach({ targetId: id }).catch(() => {});
          }
          this.frameTargets.delete(source.tabId);
        }
        // Keep console/network buffers — user may still want to read history post-detach; next attach resets them.
      } else if (source.targetId !== undefined) {
        // An iframe target went away (navigation, detach). Scrub it from every tab's set.
        for (const frames of this.frameTargets.values()) {
          frames.delete(source.targetId);
        }
      }
    });
  }

  async attach(tabId: number): Promise<void> {
    if (this.attached.has(tabId)) return;
    await chrome.debugger.attach({ tabId }, "1.3");
    await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
    await chrome.debugger.sendCommand({ tabId }, "Network.enable");
    await chrome.debugger.sendCommand({ tabId }, "Page.enable");
    this.consoles.set(tabId, new RingBuffer());
    this.networks.set(tabId, new RingBuffer());
    this.attached.add(tabId);
    this.frameTargets.set(tabId, new Map());
    // Subscribe to child-target lifecycle so we discover OOPIF frames
    // (cross-origin iframes running in a separate process). onEvent handles
    // Target.attachedToTarget / detachedFromTarget to maintain frameTargets.
    await chrome.debugger
      .sendCommand({ tabId }, "Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: false,
      })
      .catch(() => {});
  }

  async detach(tabId: number): Promise<void> {
    if (!this.attached.has(tabId)) return;
    const frames = this.frameTargets.get(tabId);
    if (frames) {
      for (const id of frames.keys()) {
        await chrome.debugger.detach({ targetId: id }).catch(() => {});
      }
      this.frameTargets.delete(tabId);
    }
    await chrome.debugger.detach({ tabId }).catch(() => {});
    this.attached.delete(tabId);
    this.consoles.delete(tabId);
    this.networks.delete(tabId);
    this.pendingDialogs.delete(tabId);
  }

  /**
   * Snapshot-time hook: yields one microtask so pending frame attachments
   * discovered via Target.attachedToTarget finish before we walk the tree.
   * Attach/detach themselves happen event-driven in onEvent.
   */
  async syncFrameTargets(tabId: number): Promise<void> {
    if (!this.attached.has(tabId)) return;
    // Yield to the macrotask queue so any pending Target.attachedToTarget
    // notifications (which arrive via IPC as macrotasks after
    // Target.setAutoAttach resolves) can fire and queue attach work.
    await new Promise<void>((r) => setTimeout(r, 0));
    const pending = this.pendingFrameAttach.get(tabId);
    if (pending && pending.size > 0) {
      await Promise.allSettled([...pending]);
    }
  }

  /** Frame targets currently attached for a tab (OOPIFs only). */
  getFrameTargets(tabId: number): FrameTargetInfo[] {
    const set = this.frameTargets.get(tabId);
    return set ? [...set.values()] : [];
  }

  private pendingFrameAttach = new Map<number, Set<Promise<void>>>();

  /**
   * Called from onEvent when Target.attachedToTarget fires for an iframe.
   * We attach a chrome.debugger API handle for the new target and enable
   * the domains we need (DOM/Runtime/Accessibility) so snapshot + click
   * handlers can reach into the frame.
   */
  private attachFrameTarget(tabId: number, targetId: string, url: string): void {
    let tabFrames = this.frameTargets.get(tabId);
    if (!tabFrames) {
      tabFrames = new Map();
      this.frameTargets.set(tabId, tabFrames);
    }
    if (tabFrames.has(targetId)) return;
    let bucket = this.pendingFrameAttach.get(tabId);
    if (!bucket) {
      bucket = new Set();
      this.pendingFrameAttach.set(tabId, bucket);
    }
    const work = (async () => {
      try {
        await chrome.debugger.attach({ targetId }, "1.3");
        await chrome.debugger.sendCommand({ targetId }, "DOM.enable");
        await chrome.debugger.sendCommand({ targetId }, "Runtime.enable");
        await chrome.debugger.sendCommand({ targetId }, "Accessibility.enable");
        tabFrames!.set(targetId, { targetId, url });
      } catch {
        await chrome.debugger.detach({ targetId }).catch(() => {});
      }
    })();
    bucket.add(work);
    work.finally(() => bucket!.delete(work));
  }

  private forgetFrameTarget(tabId: number, targetId: string): void {
    const tabFrames = this.frameTargets.get(tabId);
    if (tabFrames?.delete(targetId)) {
      void chrome.debugger.detach({ targetId }).catch(() => {});
    }
  }

  /** Return the currently-open JS dialog for a tab, if any. */
  getPendingDialog(tabId: number): PendingDialog | undefined {
    return this.pendingDialogs.get(tabId);
  }

  /** Clear the pending-dialog record for a tab (called after handling). */
  clearPendingDialog(tabId: number): void {
    this.pendingDialogs.delete(tabId);
  }

  async sendCommand<T = unknown>(
    tabId: number,
    method: string,
    params: unknown,
    targetId?: string,
  ): Promise<T> {
    await this.attach(tabId);
    if (targetId) {
      // Frame-scoped call. No reconnect-on-detach here: if an OOPIF dies
      // mid-call, the caller needs a fresh snapshot to learn its new uids
      // anyway, so just surface the error.
      try {
        return (await chrome.debugger.sendCommand({ targetId }, method, params as object)) as T;
      } catch (e) {
        const set = this.frameTargets.get(tabId);
        set?.delete(targetId);
        throw e;
      }
    }
    try {
      return (await chrome.debugger.sendCommand({ tabId }, method, params as object)) as T;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Cover both "Debugger is not attached" (between calls) and "Detached while
      // handling command" (debugger got torn off mid-flight, e.g. on navigation).
      if (!/not attached|detached/i.test(msg)) throw e;
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

    if (method === "Target.attachedToTarget") {
      const info = (params.targetInfo as { targetId?: string; type?: string; url?: string } | undefined) ?? {};
      if (info.type === "iframe" && info.targetId) {
        this.attachFrameTarget(tabId, info.targetId, info.url ?? "");
      }
      return;
    }
    if (method === "Target.detachedFromTarget") {
      const targetId = params.targetId as string | undefined;
      if (targetId) this.forgetFrameTarget(tabId, targetId);
      return;
    }

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
    } else if (method === "Page.javascriptDialogOpening") {
      this.pendingDialogs.set(tabId, {
        type: String(params.type ?? "alert"),
        message: String(params.message ?? ""),
        defaultPrompt: params.defaultPrompt as string | undefined,
        url: params.url as string | undefined,
      });
    } else if (method === "Page.javascriptDialogClosed") {
      this.pendingDialogs.delete(tabId);
    }
  }
}
