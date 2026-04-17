import { describe, expect, it } from "vitest";
import {
  derivePairing,
  derivePairingKey,
  derivePort,
  getTimezone,
  normalizePlatform,
} from "../src/pairing.js";

describe("pairing derivation", () => {
  it("normalizes Node-style platform names", () => {
    expect(normalizePlatform("darwin")).toBe("mac");
    expect(normalizePlatform("win32")).toBe("win");
    expect(normalizePlatform("linux")).toBe("linux");
  });

  it("normalizes Chrome-style platform names", () => {
    expect(normalizePlatform("mac")).toBe("mac");
    expect(normalizePlatform("win")).toBe("win");
    expect(normalizePlatform("cros")).toBe("cros");
  });

  it("falls back to 'other' for unknown platform", () => {
    expect(normalizePlatform("plan9")).toBe("other");
  });

  it("getTimezone returns a valid IANA-style string", () => {
    const tz = getTimezone();
    expect(typeof tz).toBe("string");
    expect(tz.length).toBeGreaterThan(0);
  });

  it("derivePairingKey is deterministic", async () => {
    const a = await derivePairingKey("Europe/Rome", "darwin");
    const b = await derivePairingKey("Europe/Rome", "darwin");
    expect(a).toBe(b);
  });

  it("derivePairingKey normalizes platform so Node and Chrome get the same key", async () => {
    const node = await derivePairingKey("Europe/Rome", "darwin");
    const chrome = await derivePairingKey("Europe/Rome", "mac");
    expect(node).toBe(chrome);
  });

  it("derivePairingKey produces different keys for different inputs", async () => {
    const rome = await derivePairingKey("Europe/Rome", "mac");
    const ny   = await derivePairingKey("America/New_York", "mac");
    expect(rome).not.toBe(ny);
  });

  it("derivePairingKey output is 64 hex chars (SHA-256)", async () => {
    const k = await derivePairingKey("UTC", "linux");
    expect(k).toMatch(/^[0-9a-f]{64}$/);
  });

  it("derivePort falls in the 50000-59999 range", async () => {
    for (const tz of ["UTC", "Europe/Rome", "America/New_York", "Asia/Tokyo"]) {
      const key = await derivePairingKey(tz, "linux");
      const p = derivePort(key);
      expect(p).toBeGreaterThanOrEqual(50000);
      expect(p).toBeLessThan(60000);
    }
  });

  it("derivePairing returns matching token + port", async () => {
    const r = await derivePairing({ timezone: "Europe/Rome", platform: "darwin" });
    expect(r.token).toMatch(/^[0-9a-f]{64}$/);
    expect(r.port).toBeGreaterThanOrEqual(50000);
    expect(derivePort(r.token)).toBe(r.port);
  });
});
