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

export const PageSnapshotParamsSchema = z
  .object({
    tabId: z.number().int(),
    mode: z.enum(["text", "dom", "a11y"]).default("text"),
    maxBytes: z.number().int().positive().max(2_000_000).default(500_000),
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
  .object({ tabId: z.number().int(), format: z.enum(["png", "jpeg"]).default("png") })
  .strict();
export const PageScreenshotResultSchema = z
  .object({ format: z.enum(["png", "jpeg"]), base64: z.string() })
  .strict();

/** Every method the extension must implement. */
export const METHODS = {
  "tabs.list":     { params: TabsListParamsSchema,     result: TabsListResultSchema },
  "tabs.create":   { params: TabsCreateParamsSchema,   result: TabsCreateResultSchema },
  "tabs.close":    { params: TabsCloseParamsSchema,    result: TabsCloseResultSchema },
  "tabs.activate": { params: TabsActivateParamsSchema, result: TabsActivateResultSchema },
  "page.navigate": { params: PageNavigateParamsSchema, result: PageNavigateResultSchema },
  "session.claim": { params: SessionClaimParamsSchema, result: SessionClaimResultSchema },
  "session.release": { params: SessionReleaseParamsSchema, result: SessionReleaseResultSchema },
  "page.snapshot":   { params: PageSnapshotParamsSchema,   result: PageSnapshotResultSchema },
  "page.screenshot": { params: PageScreenshotParamsSchema, result: PageScreenshotResultSchema },
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
