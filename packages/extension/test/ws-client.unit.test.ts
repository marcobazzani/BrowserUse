import { describe, expect, it } from "vitest";
import { nextBackoffMs } from "../src/ws-client.js";

describe("nextBackoffMs", () => {
  it("grows exponentially and caps at 30s", () => {
    expect(nextBackoffMs(0)).toBe(500);
    expect(nextBackoffMs(1)).toBe(1000);
    expect(nextBackoffMs(2)).toBe(2000);
    expect(nextBackoffMs(10)).toBe(30000);
  });
});
