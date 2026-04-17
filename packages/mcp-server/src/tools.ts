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
  SessionReleaseParamsSchema,
  PageEvalJsParamsSchema,
  ConsoleReadParamsSchema,
  NetworkReadParamsSchema,
} from "@browseruse/shared";
import type { BridgeServer } from "./bridge.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };
interface Tool<P> {
  description: string;
  inputSchema: z.ZodTypeAny;
  handler: (params: P) => Promise<ToolResult>;
}

function text(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function guard(bridge: Pick<BridgeServer, "isConnected">) {
  if (!bridge.isConnected()) {
    throw new Error(
      "no extension connected — install and enable the BrowserUse Chrome extension, then paste the current token into its popup"
    );
  }
}

export function buildTools(bridge: BridgeServer) {
  const claimed = new Set<number>();
  async function ensureClaim(tabId: number) {
    if (claimed.has(tabId)) return;
    await bridge.call("session.claim", { tabId });
    claimed.add(tabId);
  }

  const tabs_list: Tool<Record<string, never>> = {
    description: "List all tabs across all windows in the user's Chrome.",
    inputSchema: TabsListParamsSchema,
    handler: async () => {
      guard(bridge);
      return text(await bridge.call("tabs.list", {}));
    },
  };

  const tabs_create: Tool<z.infer<typeof TabsCreateParamsSchema>> = {
    description: "Open a new Chrome tab at the given URL. Auto-claims the new tab (Claude group + overlay).",
    inputSchema: TabsCreateParamsSchema,
    handler: async (params) => {
      guard(bridge);
      const parsed = TabsCreateParamsSchema.parse(params);
      const tab = (await bridge.call("tabs.create", parsed)) as { tabId: number };
      await ensureClaim(tab.tabId);
      return text(tab);
    },
  };

  const page_navigate: Tool<z.infer<typeof PageNavigateParamsSchema>> = {
    description: "Navigate the given tab to a URL. Auto-claims the tab.",
    inputSchema: PageNavigateParamsSchema,
    handler: async (params) => {
      guard(bridge);
      const parsed = PageNavigateParamsSchema.parse(params);
      await ensureClaim(parsed.tabId);
      return text(await bridge.call("page.navigate", parsed));
    },
  };

  const page_snapshot: Tool<z.infer<typeof PageSnapshotParamsSchema>> = {
    description:
      "Take a snapshot of the page. Default mode=a11y returns a uid-annotated accessibility tree — each interactive element has a [uid] you can pass to click/type/hover. mode=text returns innerText. mode=dom returns outerHTML. ALWAYS take a snapshot before interacting with a page. If tabId is omitted, reads the active tab.",
    inputSchema: PageSnapshotParamsSchema,
    handler: async (params) => {
      guard(bridge);
      const parsed = PageSnapshotParamsSchema.parse(params);
      if (parsed.tabId !== undefined) await ensureClaim(parsed.tabId);
      return text(await bridge.call("page.snapshot", parsed));
    },
  };

  const page_screenshot: Tool<z.infer<typeof PageScreenshotParamsSchema>> = {
    description:
      "Capture a screenshot of the visible area of a tab as a base64-encoded image. Prefer page_snapshot for understanding page structure. If tabId is omitted, reads the active tab.",
    inputSchema: PageScreenshotParamsSchema,
    handler: async (params) => {
      guard(bridge);
      const parsed = PageScreenshotParamsSchema.parse(params);
      if (parsed.tabId !== undefined) await ensureClaim(parsed.tabId);
      return text(await bridge.call("page.screenshot", parsed));
    },
  };

  const tabs_close: Tool<z.infer<typeof TabsCloseParamsSchema>> = {
    description: "Close the given tab.",
    inputSchema: TabsCloseParamsSchema,
    handler: async (params) => {
      guard(bridge);
      return text(await bridge.call("tabs.close", TabsCloseParamsSchema.parse(params)));
    },
  };

  const tabs_activate: Tool<z.infer<typeof TabsActivateParamsSchema>> = {
    description: "Bring a tab to the foreground in its window.",
    inputSchema: TabsActivateParamsSchema,
    handler: async (params) => {
      guard(bridge);
      return text(await bridge.call("tabs.activate", TabsActivateParamsSchema.parse(params)));
    },
  };

  const session_release: Tool<z.infer<typeof SessionReleaseParamsSchema>> = {
    description: "Release a tab from the Claude tab group and remove its overlay. Call when done with a tab.",
    inputSchema: SessionReleaseParamsSchema,
    handler: async (params) => {
      guard(bridge);
      return text(await bridge.call("session.release", SessionReleaseParamsSchema.parse(params)));
    },
  };

  const page_click: Tool<z.infer<typeof PageClickParamsSchema>> = {
    description:
      "Click an element by uid (from a snapshot) or CSS selector. Prefer uid — it is reliable and precise. Set includeSnapshot=true to get an updated accessibility tree in the response.",
    inputSchema: PageClickParamsSchema,
    handler: async (params) => {
      guard(bridge);
      const parsed = PageClickParamsSchema.parse(params);
      await ensureClaim(parsed.tabId);
      return text(await bridge.call("page.click", parsed));
    },
  };

  const page_type: Tool<z.infer<typeof PageTypeParamsSchema>> = {
    description:
      "Type text into an input/textarea by uid (from a snapshot) or CSS selector. Clears the field first by default. Set submit=true to submit the enclosing form. Set includeSnapshot=true to get an updated accessibility tree in the response.",
    inputSchema: PageTypeParamsSchema,
    handler: async (params) => {
      guard(bridge);
      const parsed = PageTypeParamsSchema.parse(params);
      await ensureClaim(parsed.tabId);
      return text(await bridge.call("page.type", parsed));
    },
  };

  const page_scroll: Tool<z.infer<typeof PageScrollParamsSchema>> = {
    description:
      "Scroll a tab by (dx, dy) pixels, to an element matching a CSS selector, or to 'top'/'bottom'. Provide exactly one target. Set includeSnapshot=true to get an updated accessibility tree.",
    inputSchema: PageScrollParamsSchema,
    handler: async (params) => {
      guard(bridge);
      const parsed = PageScrollParamsSchema.parse(params);
      await ensureClaim(parsed.tabId);
      return text(await bridge.call("page.scroll", parsed));
    },
  };

  const page_hover: Tool<z.infer<typeof PageHoverParamsSchema>> = {
    description:
      "Hover over an element by uid (from a snapshot) or CSS selector. Useful for revealing tooltips, dropdown menus, or hover states. Set includeSnapshot=true to get the updated page state after hover.",
    inputSchema: PageHoverParamsSchema,
    handler: async (params) => {
      guard(bridge);
      const parsed = PageHoverParamsSchema.parse(params);
      await ensureClaim(parsed.tabId);
      return text(await bridge.call("page.hover", parsed));
    },
  };

  const page_press_key: Tool<z.infer<typeof PagePressKeyParamsSchema>> = {
    description:
      "Press a keyboard key (Enter, Escape, Tab, ArrowDown, Backspace, Space, etc.). Supports modifiers: Alt, Control, Meta, Shift. Set includeSnapshot=true to get the updated page state.",
    inputSchema: PagePressKeyParamsSchema,
    handler: async (params) => {
      guard(bridge);
      const parsed = PagePressKeyParamsSchema.parse(params);
      await ensureClaim(parsed.tabId);
      return text(await bridge.call("page.pressKey", parsed));
    },
  };

  const page_fill_form: Tool<z.infer<typeof PageFillFormParamsSchema>> = {
    description:
      "Fill multiple form fields in one call. Each field is targeted by uid (from a snapshot) or CSS selector. Set submit=true to submit the form after filling. Much more efficient than multiple page_type calls.",
    inputSchema: PageFillFormParamsSchema,
    handler: async (params) => {
      guard(bridge);
      const parsed = PageFillFormParamsSchema.parse(params);
      await ensureClaim(parsed.tabId);
      return text(await bridge.call("page.fillForm", parsed));
    },
  };

  const page_handle_dialog: Tool<z.infer<typeof PageHandleDialogParamsSchema>> = {
    description:
      "Handle a JavaScript dialog (alert/confirm/prompt/beforeunload) that is currently open in the tab. action='accept' clicks OK, action='dismiss' clicks Cancel. For prompts, set promptText to the value to enter. If no dialog is open, returns handled=false.",
    inputSchema: PageHandleDialogParamsSchema,
    handler: async (params) => {
      guard(bridge);
      const parsed = PageHandleDialogParamsSchema.parse(params);
      await ensureClaim(parsed.tabId);
      return text(await bridge.call("page.handleDialog", parsed));
    },
  };

  const page_select: Tool<z.infer<typeof PageSelectParamsSchema>> = {
    description:
      "Select one or more options in a <select> dropdown by uid (from a snapshot) or CSS selector. Matches values against option value, label, or visible text. Dispatches input and change events.",
    inputSchema: PageSelectParamsSchema,
    handler: async (params) => {
      guard(bridge);
      const parsed = PageSelectParamsSchema.parse(params);
      await ensureClaim(parsed.tabId);
      return text(await bridge.call("page.select", parsed));
    },
  };

  const page_upload_file: Tool<z.infer<typeof PageUploadFileParamsSchema>> = {
    description:
      "Upload one or more files to a <input type=file> by uid (from a snapshot) or CSS selector. filePaths must be absolute paths on the user's machine that Chrome can read.",
    inputSchema: PageUploadFileParamsSchema,
    handler: async (params) => {
      guard(bridge);
      const parsed = PageUploadFileParamsSchema.parse(params);
      await ensureClaim(parsed.tabId);
      return text(await bridge.call("page.uploadFile", parsed));
    },
  };

  const page_drag: Tool<z.infer<typeof PageDragParamsSchema>> = {
    description:
      "Drag one element onto another. Source and target identified by uid (from a snapshot) or CSS selector. Useful for Trello/Jira/Notion-style drag-and-drop. Optional toOffsetX/toOffsetY shift the drop point relative to the target's centre.",
    inputSchema: PageDragParamsSchema,
    handler: async (params) => {
      guard(bridge);
      const parsed = PageDragParamsSchema.parse(params);
      await ensureClaim(parsed.tabId);
      return text(await bridge.call("page.drag", parsed));
    },
  };

  const page_eval_js: Tool<z.infer<typeof PageEvalJsParamsSchema>> = {
    description:
      "Evaluate a JavaScript expression in a tab's context. Use as an escape hatch when other tools don't cover your needs. If tabId is omitted, reads the active tab.",
    inputSchema: PageEvalJsParamsSchema,
    handler: async (params) => {
      guard(bridge);
      const parsed = PageEvalJsParamsSchema.parse(params);
      if (parsed.tabId !== undefined) await ensureClaim(parsed.tabId);
      return text(await bridge.call("page.evalJs", parsed));
    },
  };

  const console_read: Tool<z.infer<typeof ConsoleReadParamsSchema>> = {
    description: "Read buffered console messages for a tab. Observational — does not claim the tab. If tabId is omitted, reads from the active tab.",
    inputSchema: ConsoleReadParamsSchema,
    handler: async (params) => {
      guard(bridge);
      return text(await bridge.call("console.read", ConsoleReadParamsSchema.parse(params)));
    },
  };

  const network_read: Tool<z.infer<typeof NetworkReadParamsSchema>> = {
    description: "Read buffered network requests for a tab. Observational — does not claim the tab. If tabId is omitted, reads from the active tab.",
    inputSchema: NetworkReadParamsSchema,
    handler: async (params) => {
      guard(bridge);
      return text(await bridge.call("network.read", NetworkReadParamsSchema.parse(params)));
    },
  };

  return {
    tabs_list, tabs_create, tabs_close, tabs_activate,
    page_navigate, page_snapshot, page_screenshot,
    page_click, page_type, page_scroll,
    page_hover, page_press_key, page_fill_form,
    page_handle_dialog, page_select, page_upload_file, page_drag,
    session_release,
    page_eval_js, console_read, network_read,
  };
}
