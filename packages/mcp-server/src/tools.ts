import { z } from "zod";
import {
  TabsListParamsSchema,
  TabsCreateParamsSchema,
  TabsCloseParamsSchema,
  TabsActivateParamsSchema,
  PageNavigateParamsSchema,
  PageSnapshotParamsSchema,
  PageScreenshotParamsSchema,
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
  PageFetchParamsSchema,
  SessionReleaseParamsSchema,
  PageEvalJsParamsSchema,
  ConsoleReadParamsSchema,
  NetworkReadParamsSchema,
  ProfilesListParamsSchema,
} from "@browseruse/shared";
import type { BridgeServer } from "./bridge.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };
interface Tool<P> {
  description: string;
  inputSchema: z.ZodTypeAny;
  handler: (params: P) => Promise<ToolResult>;
}

/**
 * Names of every batchable tool. Kept as a literal union so the model sees
 * an enum in the JSON schema and can't ask for nonexistent tools. page_batch
 * is intentionally absent — no batches inside batches.
 */
export const BATCHABLE_TOOLS = [
  "tabs_list", "tabs_create", "tabs_close", "tabs_activate",
  "page_navigate", "page_snapshot", "page_screenshot",
  "page_click", "page_type", "page_scroll",
  "page_hover", "page_press_key", "page_fill_form",
  "page_handle_dialog", "page_select", "page_upload_file", "page_drag",
  "page_fetch", "page_eval_js",
  "console_read", "network_read",
  "session_release",
] as const;

export const PageBatchStepSchema = z.object({
  tool: z.enum(BATCHABLE_TOOLS),
  args: z.record(z.unknown()),
}).strict();

/**
 * Run several BrowserUse tools sequentially in one MCP round-trip. Eliminates
 * per-step model-loop latency for known sequences (click → type → screenshot,
 * fill several fields, navigate then snapshot). Steps run in order; the first
 * failing step aborts by default. stopOnError=false runs every step and
 * surfaces per-step errors inline.
 */
export const PageBatchParamsSchema = z.object({
  steps: z.array(PageBatchStepSchema).min(1).max(32),
  stopOnError: z.boolean().default(true),
}).strict();

const PROFILE_FIELD = z.string().min(1).optional()
  .describe("Target a specific Chrome profile (from browseruse_list_profiles). Omit if only one profile is connected.");

/**
 * Add an optional top-level `profile` field to a schema for Claude Code's tool
 * listing. Handles both ZodObject and ZodEffects (objects wrapped with
 * .superRefine / .refine): for the latter we reach into the underlying object
 * via `_def.schema`. The handler still re-parses with the original refined
 * schema, so profile routing and refinements stay enforced.
 */
function withProfile(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodObject) {
    return schema.extend({ profile: PROFILE_FIELD });
  }
  if (schema instanceof z.ZodEffects) {
    const inner = (schema as z.ZodEffects<z.ZodTypeAny>)._def.schema;
    if (inner instanceof z.ZodObject) {
      return inner.extend({ profile: PROFILE_FIELD });
    }
  }
  // Fallback: intersection with {profile?} so Claude still sees the field.
  return z.intersection(schema, z.object({ profile: PROFILE_FIELD }));
}

function text(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function guard(bridge: Pick<BridgeServer, "isConnected">) {
  if (!bridge.isConnected()) {
    throw new Error(
      "no extension connected — install and enable the BrowserUse Chrome extension on at least one Chrome profile",
    );
  }
}

function splitProfile<P extends Record<string, unknown>>(
  params: P,
): { profile?: string; params: Omit<P, "profile"> } {
  if (params && typeof params === "object" && "profile" in params) {
    const { profile, ...rest } = params as { profile?: string } & Record<string, unknown>;
    return { profile, params: rest as Omit<P, "profile"> };
  }
  return { params: params as Omit<P, "profile"> };
}

export function buildTools(bridge: BridgeServer) {
  // Per-profile claim set: a tabId only makes sense within a single Chrome instance.
  const claimed = new Set<string>();
  async function ensureClaim(tabId: number, profile?: string) {
    const key = `${profile ?? "_"}::${tabId}`;
    if (claimed.has(key)) return;
    await bridge.call("session.claim", { tabId }, profile);
    claimed.add(key);
  }

  const browseruse_list_profiles: Tool<Record<string, never>> = {
    description:
      "List the BrowserUse Chrome extensions currently connected to this MCP server. Each entry has {tag, label, connectedAt}. Call this first when more than one profile may be available; pass the chosen tag as `profile` in subsequent tool calls.",
    inputSchema: ProfilesListParamsSchema,
    handler: async () => {
      return text(bridge.listProfiles());
    },
  };

  const tabs_list: Tool<{ profile?: string }> = {
    description: "List all tabs across all windows in the target Chrome profile.",
    inputSchema: withProfile(TabsListParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile } = splitProfile(params as Record<string, unknown>);
      return text(await bridge.call("tabs.list", {}, profile));
    },
  };

  const tabs_create: Tool<z.infer<ReturnType<typeof withProfile<typeof TabsCreateParamsSchema>>>> = {
    description: "Open a new Chrome tab at the given URL. Auto-claims the new tab.",
    inputSchema: withProfile(TabsCreateParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = TabsCreateParamsSchema.parse(p);
      const tab = (await bridge.call("tabs.create", parsed, profile)) as { tabId: number };
      await ensureClaim(tab.tabId, profile);
      return text(tab);
    },
  };

  const page_navigate: Tool<z.infer<ReturnType<typeof withProfile<typeof PageNavigateParamsSchema>>>> = {
    description: "Navigate the given tab to a URL. Auto-claims the tab.",
    inputSchema: withProfile(PageNavigateParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PageNavigateParamsSchema.parse(p);
      await ensureClaim(parsed.tabId, profile);
      return text(await bridge.call("page.navigate", parsed, profile));
    },
  };

  const page_snapshot: Tool<z.infer<ReturnType<typeof withProfile<typeof PageSnapshotParamsSchema>>>> = {
    description:
      "Take a snapshot of the page. Default mode=a11y returns a uid-annotated accessibility tree — each interactive element has a [uid] you can pass to click/type/hover. mode=text returns innerText. mode=dom returns outerHTML. ALWAYS take a snapshot before interacting with a page. If tabId is omitted, reads the active tab.",
    inputSchema: withProfile(PageSnapshotParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PageSnapshotParamsSchema.parse(p);
      if (parsed.tabId !== undefined) await ensureClaim(parsed.tabId, profile);
      return text(await bridge.call("page.snapshot", parsed, profile));
    },
  };

  const page_screenshot: Tool<z.infer<ReturnType<typeof withProfile<typeof PageScreenshotParamsSchema>>>> = {
    description:
      "Capture a screenshot of the visible area of a tab as a base64-encoded image. Prefer page_snapshot for understanding page structure.",
    inputSchema: withProfile(PageScreenshotParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PageScreenshotParamsSchema.parse(p);
      if (parsed.tabId !== undefined) await ensureClaim(parsed.tabId, profile);
      return text(await bridge.call("page.screenshot", parsed, profile));
    },
  };

  const tabs_close: Tool<z.infer<ReturnType<typeof withProfile<typeof TabsCloseParamsSchema>>>> = {
    description: "Close the given tab.",
    inputSchema: withProfile(TabsCloseParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      return text(await bridge.call("tabs.close", TabsCloseParamsSchema.parse(p), profile));
    },
  };

  const tabs_activate: Tool<z.infer<ReturnType<typeof withProfile<typeof TabsActivateParamsSchema>>>> = {
    description: "Bring a tab to the foreground in its window.",
    inputSchema: withProfile(TabsActivateParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      return text(await bridge.call("tabs.activate", TabsActivateParamsSchema.parse(p), profile));
    },
  };

  const session_release: Tool<z.infer<ReturnType<typeof withProfile<typeof SessionReleaseParamsSchema>>>> = {
    description: "Release a tab from the Claude tab group and remove its overlay. Call when done with a tab.",
    inputSchema: withProfile(SessionReleaseParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      return text(await bridge.call("session.release", SessionReleaseParamsSchema.parse(p), profile));
    },
  };

  const page_click: Tool<z.infer<ReturnType<typeof withProfile<typeof PageClickParamsSchema>>>> = {
    description:
      "Click an element by uid (from a snapshot) or CSS selector. Prefer uid — it is reliable and precise. Set includeSnapshot=true to get an updated accessibility tree in the response.",
    inputSchema: withProfile(PageClickParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PageClickParamsSchema.parse(p);
      await ensureClaim(parsed.tabId, profile);
      return text(await bridge.call("page.click", parsed, profile));
    },
  };

  const page_type: Tool<z.infer<ReturnType<typeof withProfile<typeof PageTypeParamsSchema>>>> = {
    description:
      "Type text into an input/textarea by uid (from a snapshot) or CSS selector. Clears the field first by default. Set submit=true to submit the enclosing form. Set includeSnapshot=true to get an updated accessibility tree in the response. Embedded \\t becomes a Tab key and \\n becomes an Enter key, so a whole grid row or multi-line form can be entered in a single call (e.g. text=\"Name\\tAge\\nAlice\\t30\" types four cells with one round-trip — much faster than calling page_type once per cell).",
    inputSchema: withProfile(PageTypeParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PageTypeParamsSchema.parse(p);
      await ensureClaim(parsed.tabId, profile);
      return text(await bridge.call("page.type", parsed, profile));
    },
  };

  const page_scroll: Tool<z.infer<ReturnType<typeof withProfile<typeof PageScrollParamsSchema>>>> = {
    description:
      "Scroll a tab by (dx, dy) pixels, to an element matching a CSS selector, or to 'top'/'bottom'. Provide exactly one target. Set includeSnapshot=true to get an updated accessibility tree.",
    inputSchema: withProfile(PageScrollParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PageScrollParamsSchema.parse(p);
      await ensureClaim(parsed.tabId, profile);
      return text(await bridge.call("page.scroll", parsed, profile));
    },
  };

  const page_hover: Tool<z.infer<ReturnType<typeof withProfile<typeof PageHoverParamsSchema>>>> = {
    description:
      "Hover over an element by uid (from a snapshot) or CSS selector. Useful for revealing tooltips, dropdown menus, or hover states. Set includeSnapshot=true to get the updated page state after hover.",
    inputSchema: withProfile(PageHoverParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PageHoverParamsSchema.parse(p);
      await ensureClaim(parsed.tabId, profile);
      return text(await bridge.call("page.hover", parsed, profile));
    },
  };

  const page_press_key: Tool<z.infer<ReturnType<typeof withProfile<typeof PagePressKeyParamsSchema>>>> = {
    description:
      "Press a keyboard key (Enter, Escape, Tab, ArrowDown, Backspace, Space, etc.). Supports modifiers: Alt, Control, Meta, Shift. Set includeSnapshot=true to get the updated page state.",
    inputSchema: withProfile(PagePressKeyParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PagePressKeyParamsSchema.parse(p);
      await ensureClaim(parsed.tabId, profile);
      return text(await bridge.call("page.pressKey", parsed, profile));
    },
  };

  const page_fill_form: Tool<z.infer<ReturnType<typeof withProfile<typeof PageFillFormParamsSchema>>>> = {
    description:
      "Fill multiple form fields in one call. Each field is targeted by uid (from a snapshot) or CSS selector. Set submit=true to submit the form after filling. Much more efficient than multiple page_type calls.",
    inputSchema: withProfile(PageFillFormParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PageFillFormParamsSchema.parse(p);
      await ensureClaim(parsed.tabId, profile);
      return text(await bridge.call("page.fillForm", parsed, profile));
    },
  };

  const page_handle_dialog: Tool<z.infer<ReturnType<typeof withProfile<typeof PageHandleDialogParamsSchema>>>> = {
    description:
      "Handle a JavaScript dialog (alert/confirm/prompt/beforeunload) that is currently open in the tab. action='accept' clicks OK, action='dismiss' clicks Cancel. For prompts, set promptText to the value to enter. If no dialog is open, returns handled=false.",
    inputSchema: withProfile(PageHandleDialogParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PageHandleDialogParamsSchema.parse(p);
      await ensureClaim(parsed.tabId, profile);
      return text(await bridge.call("page.handleDialog", parsed, profile));
    },
  };

  const page_select: Tool<z.infer<ReturnType<typeof withProfile<typeof PageSelectParamsSchema>>>> = {
    description:
      "Select one or more options in a <select> dropdown by uid (from a snapshot) or CSS selector. Matches values against option value, label, or visible text. Dispatches input and change events.",
    inputSchema: withProfile(PageSelectParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PageSelectParamsSchema.parse(p);
      await ensureClaim(parsed.tabId, profile);
      return text(await bridge.call("page.select", parsed, profile));
    },
  };

  const page_upload_file: Tool<z.infer<ReturnType<typeof withProfile<typeof PageUploadFileParamsSchema>>>> = {
    description:
      "Upload one or more files to a <input type=file> by uid (from a snapshot) or CSS selector. filePaths must be absolute paths on the user's machine that Chrome can read.",
    inputSchema: withProfile(PageUploadFileParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PageUploadFileParamsSchema.parse(p);
      await ensureClaim(parsed.tabId, profile);
      return text(await bridge.call("page.uploadFile", parsed, profile));
    },
  };

  const page_drag: Tool<z.infer<ReturnType<typeof withProfile<typeof PageDragParamsSchema>>>> = {
    description:
      "Drag one element onto another. Source and target identified by uid (from a snapshot) or CSS selector. Useful for Trello/Jira/Notion-style drag-and-drop. Optional toOffsetX/toOffsetY shift the drop point relative to the target's centre.",
    inputSchema: withProfile(PageDragParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PageDragParamsSchema.parse(p);
      await ensureClaim(parsed.tabId, profile);
      return text(await bridge.call("page.drag", parsed, profile));
    },
  };

  const page_fetch: Tool<z.infer<ReturnType<typeof withProfile<typeof PageFetchParamsSchema>>>> = {
    description:
      "Run fetch() inside the page's JavaScript context and return the response. Reuses the page's cookies, auth tokens, and same-origin rules — ideal for calling backend APIs the page itself talks to (e.g. CRM/ERP/banking endpoints). Returns {ok, status, statusText, headers, body, json, truncated, finalUrl}. Body is auto-parsed when content-type is JSON. Prefer over page_eval_js when you're doing API calls — one round-trip instead of three.",
    inputSchema: withProfile(PageFetchParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PageFetchParamsSchema.parse(p);
      if (parsed.tabId !== undefined) await ensureClaim(parsed.tabId, profile);
      return text(await bridge.call("page.fetch", parsed, profile));
    },
  };

  const page_eval_js: Tool<z.infer<ReturnType<typeof withProfile<typeof PageEvalJsParamsSchema>>>> = {
    description:
      "Evaluate a JavaScript expression in a tab's context. Use as an escape hatch when other tools don't cover your needs.",
    inputSchema: withProfile(PageEvalJsParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PageEvalJsParamsSchema.parse(p);
      if (parsed.tabId !== undefined) await ensureClaim(parsed.tabId, profile);
      return text(await bridge.call("page.evalJs", parsed, profile));
    },
  };

  const console_read: Tool<z.infer<ReturnType<typeof withProfile<typeof ConsoleReadParamsSchema>>>> = {
    description: "Read buffered console messages for a tab. Observational — does not claim the tab.",
    inputSchema: withProfile(ConsoleReadParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      return text(await bridge.call("console.read", ConsoleReadParamsSchema.parse(p), profile));
    },
  };

  const network_read: Tool<z.infer<ReturnType<typeof withProfile<typeof NetworkReadParamsSchema>>>> = {
    description: "Read buffered network requests for a tab. Observational — does not claim the tab.",
    inputSchema: withProfile(NetworkReadParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      return text(await bridge.call("network.read", NetworkReadParamsSchema.parse(p), profile));
    },
  };

  // Tool name → handler. Built once after every tool is defined so page_batch
  // can dispatch by string. page_batch itself is excluded — no nested batches.
  const registry: Record<string, (args: never) => Promise<ToolResult>> = {
    tabs_list: tabs_list.handler,
    tabs_create: tabs_create.handler,
    tabs_close: tabs_close.handler,
    tabs_activate: tabs_activate.handler,
    page_navigate: page_navigate.handler,
    page_snapshot: page_snapshot.handler,
    page_screenshot: page_screenshot.handler,
    page_click: page_click.handler,
    page_type: page_type.handler,
    page_scroll: page_scroll.handler,
    page_hover: page_hover.handler,
    page_press_key: page_press_key.handler,
    page_fill_form: page_fill_form.handler,
    page_handle_dialog: page_handle_dialog.handler,
    page_select: page_select.handler,
    page_upload_file: page_upload_file.handler,
    page_drag: page_drag.handler,
    page_fetch: page_fetch.handler,
    page_eval_js: page_eval_js.handler,
    console_read: console_read.handler,
    network_read: network_read.handler,
    session_release: session_release.handler,
  };

  const page_batch: Tool<z.infer<ReturnType<typeof withProfile<typeof PageBatchParamsSchema>>>> = {
    description:
      "Run several BrowserUse tools sequentially in a single MCP round-trip. " +
      "Use this when you have a known sequence of actions (click → type → screenshot, " +
      "fill several fields, navigate then snapshot, write a whole row in Excel) — it " +
      "eliminates the per-step model loop latency. Steps run in order; by default the " +
      "first failure aborts the rest. Set stopOnError=false to run every step and " +
      "collect per-step errors. The batch-level profile (if set) is forwarded to each " +
      "step that doesn't override it. Cannot nest page_batch inside itself.",
    inputSchema: withProfile(PageBatchParamsSchema),
    handler: async (params) => {
      guard(bridge);
      const { profile, params: p } = splitProfile(params as Record<string, unknown>);
      const parsed = PageBatchParamsSchema.parse(p);

      const results: Array<{ tool: string; ok: boolean; result?: unknown; error?: string }> = [];
      let allOk = true;
      for (const step of parsed.steps) {
        const handler = registry[step.tool];
        if (!handler) {
          // Schema's z.enum makes this unreachable, but guard against a forgotten
          // registry entry rather than crashing the whole batch.
          results.push({ tool: step.tool, ok: false, error: `unknown tool: ${step.tool}` });
          allOk = false;
          if (parsed.stopOnError) break;
          continue;
        }
        const stepArgs = profile && !("profile" in step.args)
          ? { ...step.args, profile }
          : step.args;
        try {
          const r = await handler(stepArgs as never);
          // Tool handlers return { content: [{ type: "text", text: <json> }] }.
          // Re-parse the inner JSON so the batch result is structured, not stringly-typed.
          const inner = r.content[0]?.text ? JSON.parse(r.content[0].text as string) : null;
          results.push({ tool: step.tool, ok: true, result: inner });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          results.push({ tool: step.tool, ok: false, error: msg });
          allOk = false;
          if (parsed.stopOnError) break;
        }
      }
      return text({ ok: allOk, results });
    },
  };

  return {
    browseruse_list_profiles,
    tabs_list, tabs_create, tabs_close, tabs_activate,
    page_navigate, page_snapshot, page_screenshot,
    page_click, page_type, page_scroll,
    page_hover, page_press_key, page_fill_form,
    page_handle_dialog, page_select, page_upload_file, page_drag,
    session_release,
    page_fetch, page_eval_js, console_read, network_read,
    page_batch,
  };
}
