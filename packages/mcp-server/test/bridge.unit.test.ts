import { describe, expect, it, vi } from "vitest";
import { createCorrelator } from "../src/bridge.js";

describe("correlator", () => {
  it("matches response to its request by id", async () => {
    const c = createCorrelator({ timeoutMs: 500 });
    const p = c.register(1);
    c.resolve({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    await expect(p).resolves.toEqual({ ok: true });
  });

  it("rejects when error response arrives", async () => {
    const c = createCorrelator({ timeoutMs: 500 });
    const p = c.register(2);
    c.resolve({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: "boom" } });
    await expect(p).rejects.toThrow(/boom/);
  });

  it("times out with descriptive error", async () => {
    vi.useFakeTimers();
    const c = createCorrelator({ timeoutMs: 100 });
    const p = c.register(3);
    vi.advanceTimersByTime(150);
    await expect(p).rejects.toThrow(/timed out/i);
    vi.useRealTimers();
  });

  it("handles multiple in-flight requests without cross-talk", async () => {
    const c = createCorrelator({ timeoutMs: 500 });
    const a = c.register(10);
    const b = c.register(11);
    c.resolve({ jsonrpc: "2.0", id: 11, result: "B" });
    c.resolve({ jsonrpc: "2.0", id: 10, result: "A" });
    await expect(a).resolves.toBe("A");
    await expect(b).resolves.toBe("B");
  });

  it("drops responses with unknown ids silently", () => {
    const c = createCorrelator({ timeoutMs: 500 });
    expect(() =>
      c.resolve({ jsonrpc: "2.0", id: 999, result: null })
    ).not.toThrow();
  });

  it("rejects the previous pending promise if register is called with a duplicate id", async () => {
    const c = createCorrelator({ timeoutMs: 500 });
    const first = c.register(42);
    const second = c.register(42);
    await expect(first).rejects.toThrow(/reused/i);
    c.resolve({ jsonrpc: "2.0", id: 42, result: "ok" });
    await expect(second).resolves.toBe("ok");
  });
});
