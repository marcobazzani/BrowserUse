import { z } from "zod";

/** First frame from extension to server on every new WS connection. */
export const ClientHelloSchema = z.object({
  type: z.literal("hello"),
  token: z.string().min(8),
  /** Stable per-install identifier (sha256 of chrome.runtime.id). Routes tool calls. */
  profile: z.string().min(1).optional(),
  /** Human-readable label shown in list_profiles (defaults to profile tag prefix). */
  label: z.string().min(1).max(64).optional(),
});
export type ClientHello = z.infer<typeof ClientHelloSchema>;

/** First frame from an MCP proxy (secondary Claude Code session) to the hub. */
export const ProxyHelloSchema = z.object({
  type: z.literal("mcp-proxy-hello"),
  token: z.string().min(8),
}).strict();

/** Proxy → hub: forwarded MCP request (JSON-RPC body from Claude Code's stdio). */
export const ProxyRequestFrameSchema = z.object({
  type: z.literal("mcp-request"),
  msg: z.unknown(),
}).strict();

/** Hub → proxy: the matching MCP response (JSON-RPC body to send back on stdio). */
export const ProxyResponseFrameSchema = z.object({
  type: z.literal("mcp-response"),
  msg: z.unknown(),
}).strict();

/** Entry returned by list_profiles. */
export const ProfileInfoSchema = z.object({
  tag: z.string(),
  label: z.string(),
  connectedAt: z.number(),
}).strict();
export type ProfileInfo = z.infer<typeof ProfileInfoSchema>;

export const ProfilesListParamsSchema = z.object({}).strict();
export const ProfilesListResultSchema = z.array(ProfileInfoSchema);

/** Tab summary returned by the extension. */
export const TabSchema = z.object({
  tabId: z.number().int(),
  url: z.string(),
  title: z.string(),
  active: z.boolean(),
  windowId: z.number().int().optional(),
}).strict();
export type Tab = z.infer<typeof TabSchema>;

/* Per-method params/results. */
export const TabsListParamsSchema = z.object({}).strict();
export const TabsListResultSchema = z.array(TabSchema);

export const HttpUrlSchema = z
  .string()
  .url()
  .refine((u) => /^https?:/i.test(u), "only http(s) URLs are allowed");

export const TabsCreateParamsSchema = z
  .object({ url: HttpUrlSchema, active: z.boolean().default(true) })
  .strict();
export const TabsCreateResultSchema = TabSchema;

export const TabsCloseParamsSchema = z.object({ tabId: z.number().int() }).strict();
export const TabsCloseResultSchema = z.object({ ok: z.literal(true) }).strict();

export const TabsActivateParamsSchema = z.object({ tabId: z.number().int() }).strict();
export const TabsActivateResultSchema = z.object({ ok: z.literal(true) }).strict();

export const PageNavigateParamsSchema = z
  .object({
    tabId: z.number().int(),
    url: HttpUrlSchema,
    waitUntil: z.enum(["load", "domcontentloaded"]).default("load"),
  })
  .strict();
export const PageNavigateResultSchema = z.object({
  ok: z.literal(true),
  finalUrl: z.string().url(),
}).strict();

export const SessionClaimParamsSchema = z.object({ tabId: z.number().int() }).strict();
export const SessionClaimResultSchema = z.object({
  ok: z.literal(true),
  groupId: z.number().int(),
}).strict();

export const SessionReleaseParamsSchema = z.object({ tabId: z.number().int() }).strict();
export const SessionReleaseResultSchema = z.object({ ok: z.literal(true) }).strict();

/* ---------- Snapshot (a11y mode now returns uid-annotated CDP tree) ---------- */

export const PageSnapshotParamsSchema = z
  .object({
    tabId: z.number().int().optional(),
    mode: z.enum(["text", "dom", "a11y"]).default("a11y"),
    maxBytes: z.number().int().positive().max(2_000_000).default(80_000),
    includeBounds: z.boolean().default(false),
  })
  .strict();
export const PageSnapshotResultSchema = z
  .object({
    mode: z.enum(["text", "dom", "a11y"]),
    url: z.string(),
    title: z.string(),
    content: z.string(),
    truncated: z.boolean(),
  })
  .strict();

export const PageScreenshotParamsSchema = z
  .object({
    tabId: z.number().int().optional(),
    format: z.enum(["png", "jpeg"]).default("jpeg"),
    quality: z.number().int().min(1).max(100).default(60),
  })
  .strict();
export const PageScreenshotResultSchema = z
  .object({
    format: z.enum(["png", "jpeg"]),
    base64: z.string(),
    viewport: z.object({
      width: z.number(),
      height: z.number(),
      devicePixelRatio: z.number(),
      scrollX: z.number(),
      scrollY: z.number(),
    }).optional(),
  })
  .strict();

/* ---------- Interaction: click, type, scroll (uid OR selector) ---------- */

export const PageClickParamsSchema = z
  .object({
    tabId: z.number().int(),
    uid: z.string().min(1).optional(),
    selector: z.string().min(1).optional(),
    button: z.enum(["left", "right", "middle"]).default("left"),
    scrollIntoView: z.boolean().default(true),
    includeSnapshot: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.uid && !v.selector) {
      ctx.addIssue({ code: "custom", message: "provide either uid or selector" });
    }
  });
export const PageClickResultSchema = z.object({
  ok: z.literal(true),
  snapshot: z.string().optional(),
}).strict();

export const PageTypeParamsSchema = z
  .object({
    tabId: z.number().int(),
    /**
     * Optional. When provided, the element is focused (with self-verification)
     * before typing. When OMITTED, page.type dispatches keystrokes at the
     * current focus without resolving or focusing any element — useful after
     * a page_click_xy lands on a virtual-canvas cell that doesn't have a uid
     * (Excel grid cell, Sheets cell, Figma frame). Mirrors the canonical
     * "screenshot → coordinate click → type at current focus" pattern.
     */
    uid: z.string().min(1).optional(),
    selector: z.string().min(1).optional(),
    text: z.string(),
    submit: z.boolean().default(false),
    clear: z.boolean().default(true),
    requireEmpty: z.boolean().default(false),
    includeSnapshot: z.boolean().default(false),
  })
  .strict();
export const PageTypeResultSchema = z.object({
  ok: z.literal(true),
  snapshot: z.string().optional(),
}).strict();

export const PageScrollParamsSchema = z
  .object({
    tabId: z.number().int(),
    dx: z.number().optional(),
    dy: z.number().optional(),
    selector: z.string().min(1).optional(),
    to: z.enum(["top", "bottom"]).optional(),
    smooth: z.boolean().default(false),
    includeSnapshot: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    const count = [v.dx !== undefined || v.dy !== undefined, v.selector !== undefined, v.to !== undefined]
      .filter(Boolean).length;
    if (count === 0) {
      ctx.addIssue({ code: "custom", message: "provide one of: (dx/dy), selector, or to" });
    }
    if (count > 1) {
      ctx.addIssue({ code: "custom", message: "provide exactly one of: (dx/dy), selector, or to" });
    }
  });
export const PageScrollResultSchema = z.object({
  ok: z.literal(true),
  snapshot: z.string().optional(),
}).strict();

/* ---------- Hover ---------- */

export const PageHoverParamsSchema = z
  .object({
    tabId: z.number().int(),
    uid: z.string().min(1).optional(),
    selector: z.string().min(1).optional(),
    includeSnapshot: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.uid && !v.selector) {
      ctx.addIssue({ code: "custom", message: "provide either uid or selector" });
    }
  });
export const PageHoverResultSchema = z.object({
  ok: z.literal(true),
  snapshot: z.string().optional(),
}).strict();

/* ---------- Coordinate-click (vision-driven escape hatch) ---------- */

/**
 * Click at absolute viewport coordinates. The escape hatch for virtual-canvas
 * widgets where uid-based clicks don't resolve to specific cells (Excel grid,
 * Sheets, Figma, any custom-rendered surface). Workflow: page_screenshot →
 * model identifies (x, y) from the rendered image → page_click_xy.
 *
 * Coordinates are in the active viewport's device-independent pixels.
 */
export const PageClickXyParamsSchema = z
  .object({
    tabId: z.number().int(),
    x: z.number().min(0),
    y: z.number().min(0),
    button: z.enum(["left", "right", "middle"]).default("left"),
    clickCount: z.number().int().min(1).max(3).default(1),
    includeSnapshot: z.boolean().default(false),
  })
  .strict();
export const PageClickXyResultSchema = z.object({
  ok: z.literal(true),
  snapshot: z.string().optional(),
}).strict();

/* ---------- Focus (loud, verifying) ---------- */

/**
 * Make a target element the active element, with verification. Useful when
 * an SPA's input pipeline ignores plain JS focus() (Excel for the Web grid,
 * Sheets, Figma) — the model can escalate explicitly via mode, and gets back
 * an honest report of the actual activeElement when the focus didn't take.
 *
 * Mode semantics:
 *  - auto:        try JS focus → verify → escalate to coordinate-click on mismatch.
 *  - js:          JS focus only (the historical behaviour). No escalation.
 *  - click:       coordinate-click only. No prior JS focus().
 *  - blur+click:  drop sticky focus first via document.activeElement.blur(),
 *                 then coordinate-click. Strongest dislodge for apps that pin focus.
 */
export const PageFocusParamsSchema = z
  .object({
    tabId: z.number().int(),
    uid: z.string().min(1).optional(),
    selector: z.string().min(1).optional(),
    mode: z.enum(["auto", "js", "click", "blur+click"]).default("auto"),
    includeSnapshot: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.uid && !v.selector) {
      ctx.addIssue({ code: "custom", message: "provide either uid or selector" });
    }
  });
export const PageFocusResultSchema = z.object({
  ok: z.literal(true),
  /** True when document.activeElement === target after the focus dance. */
  focused: z.boolean(),
  /** Mode that ultimately resulted in the reported state. */
  modeUsed: z.enum(["js", "click", "blur+click"]),
  /** When focused=false, what activeElement actually is (for the model to diagnose). */
  actualTag: z.string().optional(),
  actualRole: z.string().nullable().optional(),
  actualName: z.string().optional(),
  snapshot: z.string().optional(),
}).strict();

/* ---------- Press key ---------- */

export const PagePressKeyParamsSchema = z
  .object({
    tabId: z.number().int(),
    key: z.string().min(1),
    modifiers: z.array(z.enum(["Alt", "Control", "Meta", "Shift"])).default([]),
    includeSnapshot: z.boolean().default(false),
  })
  .strict();
export const PagePressKeyResultSchema = z.object({
  ok: z.literal(true),
  snapshot: z.string().optional(),
}).strict();

/* ---------- Focus state ---------- */

export const PageFocusStateParamsSchema = z
  .object({
    tabId: z.number().int(),
  })
  .strict();
export const PageFocusStateResultSchema = z.object({
  ok: z.literal(true),
  targetId: z.string().optional(),
  url: z.string(),
  title: z.string(),
  documentHasFocus: z.boolean(),
  activeTag: z.string(),
  activeRole: z.string().nullable().optional(),
  activeName: z.string().optional(),
  activeValue: z.string().optional(),
  activeText: z.string().optional(),
  selectedText: z.string().optional(),
  selectionStart: z.number().nullable().optional(),
  selectionEnd: z.number().nullable().optional(),
  activeDescendant: z.string().optional(),
  activeDescendantTag: z.string().optional(),
  activeDescendantRole: z.string().nullable().optional(),
  activeDescendantName: z.string().optional(),
  activeDescendantValue: z.string().optional(),
  activeDescendantText: z.string().optional(),
  activeDescendantRowIndex: z.string().optional(),
  activeDescendantColIndex: z.string().optional(),
  activeDescendantBounds: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  }).optional(),
  ariaRowIndex: z.string().optional(),
  ariaColIndex: z.string().optional(),
}).strict();

/* ---------- Fill form (batch) ---------- */

export const FillFormFieldSchema = z.object({
  uid: z.string().min(1).optional(),
  selector: z.string().min(1).optional(),
  value: z.string(),
}).strict().superRefine((v, ctx) => {
  if (!v.uid && !v.selector) {
    ctx.addIssue({ code: "custom", message: "provide either uid or selector" });
  }
});

export const PageFillFormParamsSchema = z
  .object({
    tabId: z.number().int(),
    fields: z.array(FillFormFieldSchema).min(1),
    submit: z.boolean().default(false),
    includeSnapshot: z.boolean().default(false),
  })
  .strict();
export const PageFillFormResultSchema = z.object({
  ok: z.literal(true),
  filledCount: z.number().int(),
  snapshot: z.string().optional(),
}).strict();

/* ---------- Dialog handling ---------- */

export const PageHandleDialogParamsSchema = z
  .object({
    tabId: z.number().int(),
    action: z.enum(["accept", "dismiss"]).default("accept"),
    promptText: z.string().optional(),
  })
  .strict();
export const PageHandleDialogResultSchema = z
  .object({
    ok: z.literal(true),
    handled: z.boolean(),
    dialogType: z.string().optional(),
    dialogMessage: z.string().optional(),
  })
  .strict();

/* ---------- Select (dropdown) ---------- */

export const PageSelectParamsSchema = z
  .object({
    tabId: z.number().int(),
    uid: z.string().min(1).optional(),
    selector: z.string().min(1).optional(),
    // pick the option whose value OR visible text matches one of these strings
    values: z.array(z.string()).min(1),
    includeSnapshot: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.uid && !v.selector) {
      ctx.addIssue({ code: "custom", message: "provide either uid or selector" });
    }
  });
export const PageSelectResultSchema = z
  .object({
    ok: z.literal(true),
    selected: z.array(z.string()),
    snapshot: z.string().optional(),
  })
  .strict();

/* ---------- Upload file ---------- */

export const PageUploadFileParamsSchema = z
  .object({
    tabId: z.number().int(),
    uid: z.string().min(1).optional(),
    selector: z.string().min(1).optional(),
    filePaths: z.array(z.string().min(1)).min(1),
    includeSnapshot: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.uid && !v.selector) {
      ctx.addIssue({ code: "custom", message: "provide either uid or selector" });
    }
  });
export const PageUploadFileResultSchema = z
  .object({
    ok: z.literal(true),
    uploadedCount: z.number().int(),
    snapshot: z.string().optional(),
  })
  .strict();

/* ---------- Drag ---------- */

export const PageDragParamsSchema = z
  .object({
    tabId: z.number().int(),
    fromUid: z.string().min(1).optional(),
    fromSelector: z.string().min(1).optional(),
    toUid: z.string().min(1).optional(),
    toSelector: z.string().min(1).optional(),
    // offset applied to the target centre (useful for drop zones that only accept a specific region)
    toOffsetX: z.number().optional(),
    toOffsetY: z.number().optional(),
    steps: z.number().int().min(1).max(50).default(10),
    includeSnapshot: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.fromUid && !v.fromSelector) {
      ctx.addIssue({ code: "custom", message: "provide fromUid or fromSelector" });
    }
    if (!v.toUid && !v.toSelector) {
      ctx.addIssue({ code: "custom", message: "provide toUid or toSelector" });
    }
  });
export const PageDragResultSchema = z
  .object({
    ok: z.literal(true),
    snapshot: z.string().optional(),
  })
  .strict();

/* ---------- Fetch (in-page) ---------- */

export const PageFetchParamsSchema = z
  .object({
    tabId: z.number().int().optional(),
    url: z.string().min(1),   // relative or absolute; resolved against the page origin
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).default("GET"),
    headers: z.record(z.string()).optional(),
    // Body may be a string or a JSON-serialisable object (we stringify objects).
    body: z.union([z.string(), z.record(z.unknown()), z.array(z.unknown())]).optional(),
    credentials: z.enum(["include", "same-origin", "omit"]).default("include"),
    timeoutMs: z.number().int().positive().max(60_000).default(15_000),
    // Cap on response body bytes (text length). Default 200 KB.
    maxBytes: z.number().int().positive().max(2_000_000).default(200_000),
  })
  .strict();

export const PageFetchResultSchema = z
  .object({
    ok: z.boolean(),
    status: z.number().int(),
    statusText: z.string(),
    headers: z.record(z.string()),
    // Body: parsed JSON if content-type is JSON, else raw text.
    body: z.unknown(),
    // Whether body was auto-parsed as JSON.
    json: z.boolean(),
    truncated: z.boolean(),
    finalUrl: z.string(),
  })
  .strict();

/* ---------- Escape hatch & logs ---------- */

export const PageEvalJsParamsSchema = z.object({
  tabId: z.number().int().optional(),
  expression: z.string().min(1),
  awaitPromise: z.boolean().default(true),
  returnByValue: z.boolean().default(true),
  timeoutMs: z.number().int().positive().max(30_000).default(5_000),
}).strict();
export const PageEvalJsResultSchema = z.object({
  type: z.string(),
  value: z.unknown().optional(),
  description: z.string().optional(),
  exception: z.string().optional(),
}).strict();

export const ConsoleEntrySchema = z.object({
  ts: z.number(),
  level: z.enum(["log", "info", "warn", "error", "debug"]),
  text: z.string(),
}).strict();
export const ConsoleReadParamsSchema = z.object({
  tabId: z.number().int().optional(),
  pattern: z.string().optional(),
  since: z.number().optional(),
  limit: z.number().int().positive().max(2000).default(500),
}).strict();
export const ConsoleReadResultSchema = z.array(ConsoleEntrySchema);

export const NetworkEntrySchema = z.object({
  ts: z.number(),
  method: z.string(),
  url: z.string(),
  status: z.number().int().optional(),
  durationMs: z.number().optional(),
  type: z.string(),
}).strict();
export const NetworkReadParamsSchema = z.object({
  tabId: z.number().int().optional(),
  pattern: z.string().optional(),
  since: z.number().optional(),
  limit: z.number().int().positive().max(2000).default(500),
}).strict();
export const NetworkReadResultSchema = z.array(NetworkEntrySchema);

/** Every method the extension must implement. */
export const METHODS = {
  "tabs.list":       { params: TabsListParamsSchema,       result: TabsListResultSchema },
  "tabs.create":     { params: TabsCreateParamsSchema,     result: TabsCreateResultSchema },
  "tabs.close":      { params: TabsCloseParamsSchema,      result: TabsCloseResultSchema },
  "tabs.activate":   { params: TabsActivateParamsSchema,   result: TabsActivateResultSchema },
  "page.navigate":   { params: PageNavigateParamsSchema,   result: PageNavigateResultSchema },
  "session.claim":   { params: SessionClaimParamsSchema,   result: SessionClaimResultSchema },
  "session.release": { params: SessionReleaseParamsSchema, result: SessionReleaseResultSchema },
  "page.snapshot":   { params: PageSnapshotParamsSchema,   result: PageSnapshotResultSchema },
  "page.screenshot": { params: PageScreenshotParamsSchema, result: PageScreenshotResultSchema },
  "page.click":      { params: PageClickParamsSchema,      result: PageClickResultSchema },
  "page.type":       { params: PageTypeParamsSchema,       result: PageTypeResultSchema },
  "page.scroll":     { params: PageScrollParamsSchema,     result: PageScrollResultSchema },
  "page.hover":      { params: PageHoverParamsSchema,      result: PageHoverResultSchema },
  "page.focus":      { params: PageFocusParamsSchema,      result: PageFocusResultSchema },
  "page.clickXy":    { params: PageClickXyParamsSchema,    result: PageClickXyResultSchema },
  "page.pressKey":   { params: PagePressKeyParamsSchema,   result: PagePressKeyResultSchema },
  "page.focusState": { params: PageFocusStateParamsSchema, result: PageFocusStateResultSchema },
  "page.fillForm":   { params: PageFillFormParamsSchema,   result: PageFillFormResultSchema },
  "page.handleDialog": { params: PageHandleDialogParamsSchema, result: PageHandleDialogResultSchema },
  "page.select":     { params: PageSelectParamsSchema,     result: PageSelectResultSchema },
  "page.uploadFile": { params: PageUploadFileParamsSchema, result: PageUploadFileResultSchema },
  "page.drag":       { params: PageDragParamsSchema,       result: PageDragResultSchema },
  "page.fetch":      { params: PageFetchParamsSchema,      result: PageFetchResultSchema },
  "profiles.list":   { params: ProfilesListParamsSchema,   result: ProfilesListResultSchema },
  "page.evalJs":     { params: PageEvalJsParamsSchema,     result: PageEvalJsResultSchema },
  "console.read":    { params: ConsoleReadParamsSchema,    result: ConsoleReadResultSchema },
  "network.read":    { params: NetworkReadParamsSchema,    result: NetworkReadResultSchema },
} as const;
export type MethodName = keyof typeof METHODS;

export type MethodParams<M extends MethodName> = z.input<(typeof METHODS)[M]["params"]>;
export type MethodResult<M extends MethodName> = z.output<(typeof METHODS)[M]["result"]>;

/** JSON-RPC 2.0 request / response envelopes. */
export const RpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.number(), z.string()]),
  method: z.string(),
  params: z.unknown().optional(),
});
export type RpcRequest = z.infer<typeof RpcRequestSchema>;

export const RpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type RpcError = z.infer<typeof RpcErrorSchema>;

export const RpcResponseSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.number(), z.string()]),
    result: z.unknown().optional(),
    error: RpcErrorSchema.optional(),
  })
  .refine((v) => (v.result === undefined) !== (v.error === undefined), {
    message: "exactly one of result / error must be set",
  });
export type RpcResponse = z.infer<typeof RpcResponseSchema>;
