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
});
export type Tab = z.infer<typeof TabSchema>;

/* Per-method params/results. */
export const TabsListParamsSchema = z.object({}).strict();
export const TabsListResultSchema = z.array(TabSchema);

const HttpUrl = z
  .string()
  .url()
  .refine((u) => /^https?:/i.test(u), "only http(s) URLs are allowed");

export const TabsCreateParamsSchema = z
  .object({ url: HttpUrl, active: z.boolean().default(true) })
  .strict();
export const TabsCreateResultSchema = TabSchema;

export const TabsCloseParamsSchema = z.object({ tabId: z.number().int() }).strict();
export const TabsCloseResultSchema = z.object({ ok: z.literal(true) });

export const TabsActivateParamsSchema = z.object({ tabId: z.number().int() }).strict();
export const TabsActivateResultSchema = z.object({ ok: z.literal(true) });

export const PageNavigateParamsSchema = z
  .object({
    tabId: z.number().int(),
    url: HttpUrl,
    waitUntil: z.enum(["load", "domcontentloaded"]).default("load"),
  })
  .strict();
export const PageNavigateResultSchema = z.object({
  ok: z.literal(true),
  finalUrl: z.string().url(),
});

export const SessionClaimParamsSchema = z.object({ tabId: z.number().int() }).strict();
export const SessionClaimResultSchema = z.object({
  ok: z.literal(true),
  groupId: z.number().int(),
});

export const SessionReleaseParamsSchema = z.object({ tabId: z.number().int() }).strict();
export const SessionReleaseResultSchema = z.object({ ok: z.literal(true) });

/** Every method the extension must implement. */
export const METHODS = {
  "tabs.list":     { params: TabsListParamsSchema,     result: TabsListResultSchema },
  "tabs.create":   { params: TabsCreateParamsSchema,   result: TabsCreateResultSchema },
  "tabs.close":    { params: TabsCloseParamsSchema,    result: TabsCloseResultSchema },
  "tabs.activate": { params: TabsActivateParamsSchema, result: TabsActivateResultSchema },
  "page.navigate": { params: PageNavigateParamsSchema, result: PageNavigateResultSchema },
  "session.claim": { params: SessionClaimParamsSchema, result: SessionClaimResultSchema },
  "session.release": { params: SessionReleaseParamsSchema, result: SessionReleaseResultSchema },
} as const;
export type MethodName = keyof typeof METHODS;

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
