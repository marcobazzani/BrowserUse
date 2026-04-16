import { describe, expect, it } from "vitest";
import {
  ClientHelloSchema,
  RpcRequestSchema,
  RpcResponseSchema,
  TabsListResultSchema,
  TabsCreateParamsSchema,
  PageNavigateParamsSchema,
  PageSnapshotParamsSchema,
  PageScreenshotParamsSchema,
  SessionClaimResultSchema,
} from "../src/protocol.js";

describe("protocol round-trip", () => {
  it("validates client hello", () => {
    const msg = { type: "hello" as const, token: "abc12345" };
    expect(ClientHelloSchema.parse(msg)).toEqual(msg);
  });

  it("validates tabs.list request with no params", () => {
    const req = { jsonrpc: "2.0" as const, id: 1, method: "tabs.list" };
    expect(RpcRequestSchema.parse(req)).toEqual(req);
  });

  it("validates tabs.list result", () => {
    const result = [{ tabId: 17, url: "https://example.com", title: "Example", active: true }];
    expect(TabsListResultSchema.parse(result)).toEqual(result);
  });

  it("validates tabs.create params", () => {
    const params = { url: "https://example.com", active: true };
    expect(TabsCreateParamsSchema.parse(params)).toEqual(params);
  });

  it("rejects tabs.create with non-http(s) url", () => {
    expect(() =>
      TabsCreateParamsSchema.parse({ url: "javascript:alert(1)" })
    ).toThrow();
  });

  it("validates page.navigate params with default waitUntil", () => {
    const parsed = PageNavigateParamsSchema.parse({ tabId: 1, url: "https://example.com" });
    expect(parsed.waitUntil).toBe("load");
  });

  it("validates session.claim result", () => {
    const result = { ok: true as const, groupId: 42 };
    expect(SessionClaimResultSchema.parse(result)).toEqual(result);
  });

  it("rpc response with error excludes result", () => {
    const err = {
      jsonrpc: "2.0" as const,
      id: 1,
      error: { code: -32601, message: "Method not found" },
    };
    expect(RpcResponseSchema.parse(err)).toEqual(err);
  });

  it("rejects rpc response with both result and error", () => {
    expect(() =>
      RpcResponseSchema.parse({
        jsonrpc: "2.0",
        id: 1,
        result: { anything: true },
        error: { code: -32000, message: "nope" },
      })
    ).toThrow();
  });

  it("rejects rpc response with neither result nor error", () => {
    expect(() =>
      RpcResponseSchema.parse({ jsonrpc: "2.0", id: 1 })
    ).toThrow();
  });

  it("rejects tabs.create params with unknown fields (strict)", () => {
    expect(() =>
      TabsCreateParamsSchema.parse({ url: "https://example.com", bogus: true })
    ).toThrow();
  });

  it("page.snapshot params default mode=text and maxBytes=500000", () => {
    const parsed = PageSnapshotParamsSchema.parse({ tabId: 1 });
    expect(parsed.mode).toBe("text");
    expect(parsed.maxBytes).toBe(500_000);
  });

  it("page.screenshot params default format=png", () => {
    expect(PageScreenshotParamsSchema.parse({ tabId: 1 }).format).toBe("png");
  });

  it("page.snapshot rejects mode outside enum", () => {
    expect(() => PageSnapshotParamsSchema.parse({ tabId: 1, mode: "xml" })).toThrow();
  });
});
