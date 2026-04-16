import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextBackoffMs, WsClient } from "../src/ws-client.js";
import { Dispatcher } from "../src/dispatcher.js";

describe("nextBackoffMs", () => {
  it("grows exponentially and caps at 30s", () => {
    expect(nextBackoffMs(0)).toBe(500);
    expect(nextBackoffMs(1)).toBe(1000);
    expect(nextBackoffMs(2)).toBe(2000);
    expect(nextBackoffMs(10)).toBe(30000);
  });
});

describe("WsClient reconnect timer hygiene", () => {
  const sockets: FakeWebSocket[] = [];

  class FakeWebSocket {
    readyState = 0;
    listeners: Record<string, ((ev: any) => void)[]> = {};
    sent: string[] = [];
    constructor(public url: string) {
      sockets.push(this);
    }
    addEventListener(type: string, cb: (ev: any) => void) {
      (this.listeners[type] ||= []).push(cb);
    }
    dispatch(type: string, ev: any) {
      for (const cb of this.listeners[type] ?? []) cb(ev);
    }
    send(s: string) { this.sent.push(s); }
    close() { this.readyState = 3; this.dispatch("close", { code: 1006 }); }
  }

  beforeEach(() => {
    sockets.length = 0;
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("does not open a second socket when start() is called while a reconnect is pending", async () => {
    const client = new WsClient(
      { url: "ws://127.0.0.1:0", getToken: async () => "tokentoken", onStatus: () => {} },
      new Dispatcher()
    );
    client.start();
    // flush the microtask that awaits getToken(), and the constructor that pushes the first FakeWebSocket
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets.length).toBe(1);

    // Simulate a drop → schedules reconnect timer
    sockets[0]!.dispatch("close", { code: 1006 });

    // Call stop() then start() while the reconnect timer is still pending
    client.stop();
    client.start();
    await vi.advanceTimersByTimeAsync(0);

    // Before the fix: advancing past the backoff would open a duplicate socket.
    await vi.advanceTimersByTimeAsync(2000);
    // After start(), one new socket opens — but no duplicate should fire.
    expect(sockets.length).toBe(2);
  });
});
