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
  PageClickParamsSchema,
  PageTypeParamsSchema,
  PageScrollParamsSchema,
  PageHoverParamsSchema,
  PagePressKeyParamsSchema,
  PageFillFormParamsSchema,
  PageHandleDialogParamsSchema,
  PageSelectParamsSchema,
  PageUploadFileParamsSchema,
  PageDragParamsSchema,
  PageEvalJsParamsSchema,
  ConsoleReadParamsSchema,
  ConsoleReadResultSchema,
  NetworkReadParamsSchema,
  NetworkReadResultSchema,
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

  it("page.snapshot params default mode=a11y and maxBytes=80000", () => {
    const parsed = PageSnapshotParamsSchema.parse({ tabId: 1 });
    expect(parsed.mode).toBe("a11y");
    expect(parsed.maxBytes).toBe(80_000);
  });

  it("page.snapshot params accept no tabId (active-tab fallback)", () => {
    const parsed = PageSnapshotParamsSchema.parse({});
    expect(parsed.tabId).toBeUndefined();
  });

  it("page.screenshot params default format=jpeg and quality=60", () => {
    const parsed = PageScreenshotParamsSchema.parse({ tabId: 1 });
    expect(parsed.format).toBe("jpeg");
    expect(parsed.quality).toBe(60);
  });

  it("page.screenshot params accept no tabId (active-tab fallback)", () => {
    const parsed = PageScreenshotParamsSchema.parse({});
    expect(parsed.tabId).toBeUndefined();
  });

  // --- click: uid OR selector ---
  it("page.click accepts uid", () => {
    const p = PageClickParamsSchema.parse({ tabId: 1, uid: "e42" });
    expect(p.uid).toBe("e42");
    expect(p.selector).toBeUndefined();
  });
  it("page.click accepts selector", () => {
    const p = PageClickParamsSchema.parse({ tabId: 1, selector: "#go" });
    expect(p.selector).toBe("#go");
  });
  it("page.click rejects when neither uid nor selector", () => {
    expect(() => PageClickParamsSchema.parse({ tabId: 1 })).toThrow();
  });
  it("page.click defaults button=left, scrollIntoView=true, includeSnapshot=false", () => {
    const p = PageClickParamsSchema.parse({ tabId: 1, uid: "e1" });
    expect(p.button).toBe("left");
    expect(p.scrollIntoView).toBe(true);
    expect(p.includeSnapshot).toBe(false);
  });

  // --- type: uid OR selector ---
  it("page.type accepts uid", () => {
    const p = PageTypeParamsSchema.parse({ tabId: 1, uid: "e5", text: "hello" });
    expect(p.uid).toBe("e5");
  });
  it("page.type accepts selector", () => {
    const p = PageTypeParamsSchema.parse({ tabId: 1, selector: "#q", text: "hi" });
    expect(p.selector).toBe("#q");
  });
  it("page.type rejects when neither uid nor selector", () => {
    expect(() => PageTypeParamsSchema.parse({ tabId: 1, text: "hi" })).toThrow();
  });
  it("page.type defaults submit=false, clear=true, includeSnapshot=false", () => {
    const p = PageTypeParamsSchema.parse({ tabId: 1, uid: "e1", text: "hi" });
    expect(p.submit).toBe(false);
    expect(p.clear).toBe(true);
    expect(p.includeSnapshot).toBe(false);
  });

  // --- scroll ---
  it("page.scroll rejects params with no scroll target", () => {
    expect(() => PageScrollParamsSchema.parse({ tabId: 1 })).toThrow();
  });
  it("page.scroll rejects params that combine dy + selector", () => {
    expect(() => PageScrollParamsSchema.parse({ tabId: 1, dy: 100, selector: "#x" })).toThrow();
  });
  it("page.scroll accepts a selector-only scroll", () => {
    const p = PageScrollParamsSchema.parse({ tabId: 1, selector: "#footer" });
    expect(p.selector).toBe("#footer");
    expect(p.smooth).toBe(false);
    expect(p.includeSnapshot).toBe(false);
  });
  it("page.scroll accepts {to: 'bottom'}", () => {
    const p = PageScrollParamsSchema.parse({ tabId: 1, to: "bottom" });
    expect(p.to).toBe("bottom");
  });

  // --- hover ---
  it("page.hover accepts uid", () => {
    const p = PageHoverParamsSchema.parse({ tabId: 1, uid: "e7" });
    expect(p.uid).toBe("e7");
    expect(p.includeSnapshot).toBe(false);
  });
  it("page.hover accepts selector", () => {
    const p = PageHoverParamsSchema.parse({ tabId: 1, selector: ".menu-trigger" });
    expect(p.selector).toBe(".menu-trigger");
  });
  it("page.hover rejects when neither uid nor selector", () => {
    expect(() => PageHoverParamsSchema.parse({ tabId: 1 })).toThrow();
  });

  // --- pressKey ---
  it("page.pressKey validates with key only", () => {
    const p = PagePressKeyParamsSchema.parse({ tabId: 1, key: "Enter" });
    expect(p.key).toBe("Enter");
    expect(p.modifiers).toEqual([]);
    expect(p.includeSnapshot).toBe(false);
  });
  it("page.pressKey accepts modifiers", () => {
    const p = PagePressKeyParamsSchema.parse({ tabId: 1, key: "a", modifiers: ["Control"] });
    expect(p.modifiers).toEqual(["Control"]);
  });
  it("page.pressKey rejects invalid modifier", () => {
    expect(() => PagePressKeyParamsSchema.parse({ tabId: 1, key: "a", modifiers: ["Hyper"] })).toThrow();
  });

  // --- fillForm ---
  it("page.fillForm accepts array of uid-targeted fields", () => {
    const p = PageFillFormParamsSchema.parse({
      tabId: 1,
      fields: [
        { uid: "e1", value: "Alice" },
        { uid: "e2", value: "alice@example.com" },
      ],
    });
    expect(p.fields).toHaveLength(2);
    expect(p.submit).toBe(false);
    expect(p.includeSnapshot).toBe(false);
  });
  it("page.fillForm accepts selector-targeted fields", () => {
    const p = PageFillFormParamsSchema.parse({
      tabId: 1,
      fields: [{ selector: "#name", value: "Bob" }],
    });
    expect(p.fields[0].selector).toBe("#name");
  });
  it("page.fillForm rejects field without uid or selector", () => {
    expect(() => PageFillFormParamsSchema.parse({
      tabId: 1,
      fields: [{ value: "no target" }],
    })).toThrow();
  });
  it("page.fillForm rejects empty fields array", () => {
    expect(() => PageFillFormParamsSchema.parse({ tabId: 1, fields: [] })).toThrow();
  });

  // --- evalJs ---
  it("page.evalJs accepts no tabId (active-tab fallback)", () => {
    const parsed = PageEvalJsParamsSchema.parse({ expression: "1+1" });
    expect(parsed.tabId).toBeUndefined();
  });
  it("page.evalJs defaults awaitPromise=true, returnByValue=true, timeoutMs=5000", () => {
    const p = PageEvalJsParamsSchema.parse({ tabId: 1, expression: "1+1" });
    expect(p.awaitPromise).toBe(true);
    expect(p.returnByValue).toBe(true);
    expect(p.timeoutMs).toBe(5_000);
  });
  it("page.evalJs rejects empty expression", () => {
    expect(() => PageEvalJsParamsSchema.parse({ tabId: 1, expression: "" })).toThrow();
  });
  it("page.evalJs rejects timeoutMs over 30000", () => {
    expect(() => PageEvalJsParamsSchema.parse({ tabId: 1, expression: "1", timeoutMs: 99999 })).toThrow();
  });

  // --- console/network ---
  it("console.read accepts no tabId (active-tab fallback)", () => {
    const parsed = ConsoleReadParamsSchema.parse({});
    expect(parsed.tabId).toBeUndefined();
  });
  it("network.read accepts no tabId (active-tab fallback)", () => {
    const parsed = NetworkReadParamsSchema.parse({});
    expect(parsed.tabId).toBeUndefined();
  });
  it("console.read defaults limit=500", () => {
    expect(ConsoleReadParamsSchema.parse({ tabId: 1 }).limit).toBe(500);
  });
  it("console.read rejects limit over 2000", () => {
    expect(() => ConsoleReadParamsSchema.parse({ tabId: 1, limit: 9999 })).toThrow();
  });
  it("console.read result accepts array of entries", () => {
    const r = [{ ts: 1, level: "error" as const, text: "boom" }];
    expect(ConsoleReadResultSchema.parse(r)).toEqual(r);
  });
  it("network.read accepts optional status and durationMs", () => {
    const r = [{ ts: 1, method: "GET", url: "https://a", type: "Document" }];
    expect(NetworkReadResultSchema.parse(r)).toEqual(r);
  });

  // --- handle_dialog ---
  it("page.handleDialog defaults action=accept", () => {
    const p = PageHandleDialogParamsSchema.parse({ tabId: 1 });
    expect(p.action).toBe("accept");
  });
  it("page.handleDialog accepts promptText for prompt dialogs", () => {
    const p = PageHandleDialogParamsSchema.parse({ tabId: 1, action: "accept", promptText: "yes" });
    expect(p.promptText).toBe("yes");
  });
  it("page.handleDialog rejects invalid action", () => {
    expect(() => PageHandleDialogParamsSchema.parse({ tabId: 1, action: "maybe" })).toThrow();
  });

  // --- select ---
  it("page.select accepts uid + values", () => {
    const p = PageSelectParamsSchema.parse({ tabId: 1, uid: "e5", values: ["opt1"] });
    expect(p.values).toEqual(["opt1"]);
  });
  it("page.select rejects missing target", () => {
    expect(() => PageSelectParamsSchema.parse({ tabId: 1, values: ["opt1"] })).toThrow();
  });
  it("page.select rejects empty values", () => {
    expect(() => PageSelectParamsSchema.parse({ tabId: 1, uid: "e5", values: [] })).toThrow();
  });

  // --- upload_file ---
  it("page.uploadFile accepts selector + filePaths", () => {
    const p = PageUploadFileParamsSchema.parse({ tabId: 1, selector: "#file", filePaths: ["/tmp/a.png"] });
    expect(p.filePaths).toHaveLength(1);
  });
  it("page.uploadFile rejects empty filePaths", () => {
    expect(() => PageUploadFileParamsSchema.parse({ tabId: 1, uid: "e1", filePaths: [] })).toThrow();
  });

  // --- drag ---
  it("page.drag accepts fromUid + toUid", () => {
    const p = PageDragParamsSchema.parse({ tabId: 1, fromUid: "e1", toUid: "e2" });
    expect(p.fromUid).toBe("e1");
    expect(p.toUid).toBe("e2");
    expect(p.steps).toBe(10);
  });
  it("page.drag rejects missing from target", () => {
    expect(() => PageDragParamsSchema.parse({ tabId: 1, toUid: "e2" })).toThrow();
  });
  it("page.drag rejects missing to target", () => {
    expect(() => PageDragParamsSchema.parse({ tabId: 1, fromUid: "e1" })).toThrow();
  });
  it("page.drag rejects steps over 50", () => {
    expect(() => PageDragParamsSchema.parse({ tabId: 1, fromUid: "e1", toUid: "e2", steps: 100 })).toThrow();
  });
});
