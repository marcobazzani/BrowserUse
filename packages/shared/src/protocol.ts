import { z } from "zod";

/** First frame from extension to server on every new WS connection. */
export const ClientHelloSchema = z.object({
  type: z.literal("hello"),
  token: z.string().min(8),
});
export type ClientHello = z.infer<typeof ClientHelloSchema>;

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
  .object({ format: z.enum(["png", "jpeg"]), base64: z.string() })
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
    uid: z.string().min(1).optional(),
    selector: z.string().min(1).optional(),
    text: z.string(),
    submit: z.boolean().default(false),
    clear: z.boolean().default(true),
    includeSnapshot: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.uid && !v.selector) {
      ctx.addIssue({ code: "custom", message: "provide either uid or selector" });
    }
  });
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
  "page.pressKey":   { params: PagePressKeyParamsSchema,   result: PagePressKeyResultSchema },
  "page.fillForm":   { params: PageFillFormParamsSchema,   result: PageFillFormResultSchema },
  "page.handleDialog": { params: PageHandleDialogParamsSchema, result: PageHandleDialogResultSchema },
  "page.select":     { params: PageSelectParamsSchema,     result: PageSelectResultSchema },
  "page.uploadFile": { params: PageUploadFileParamsSchema, result: PageUploadFileResultSchema },
  "page.drag":       { params: PageDragParamsSchema,       result: PageDragResultSchema },
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
