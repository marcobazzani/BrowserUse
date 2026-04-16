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
  SessionReleaseParamsSchema,
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
      "Read the page content of a tab. mode=text returns innerText (default). mode=dom returns outerHTML. mode=a11y returns a flattened accessibility tree.",
    inputSchema: PageSnapshotParamsSchema,
    handler: async (params) => {
      guard(bridge);
      const parsed = PageSnapshotParamsSchema.parse(params);
      await ensureClaim(parsed.tabId);
      return text(await bridge.call("page.snapshot", parsed));
    },
  };

  const page_screenshot: Tool<z.infer<typeof PageScreenshotParamsSchema>> = {
    description:
      "Capture a screenshot of the visible area of a tab as a base64-encoded image.",
    inputSchema: PageScreenshotParamsSchema,
    handler: async (params) => {
      guard(bridge);
      const parsed = PageScreenshotParamsSchema.parse(params);
      await ensureClaim(parsed.tabId);
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
    description: "Click an element in a tab by CSS selector.",
    inputSchema: PageClickParamsSchema,
    handler: async (params) => {
      guard(bridge);
      const parsed = PageClickParamsSchema.parse(params);
      await ensureClaim(parsed.tabId);
      return text(await bridge.call("page.click", parsed));
    },
  };

  const page_type: Tool<z.infer<typeof PageTypeParamsSchema>> = {
    description: "Type text into an input/textarea by CSS selector. Optionally submits the enclosing form.",
    inputSchema: PageTypeParamsSchema,
    handler: async (params) => {
      guard(bridge);
      const parsed = PageTypeParamsSchema.parse(params);
      await ensureClaim(parsed.tabId);
      return text(await bridge.call("page.type", parsed));
    },
  };

  const page_scroll: Tool<z.infer<typeof PageScrollParamsSchema>> = {
    description: "Scroll a tab by (dx, dy) pixels, to an element matching a CSS selector, or to 'top'/'bottom'. Provide exactly one target.",
    inputSchema: PageScrollParamsSchema,
    handler: async (params) => {
      guard(bridge);
      const parsed = PageScrollParamsSchema.parse(params);
      await ensureClaim(parsed.tabId);
      return text(await bridge.call("page.scroll", parsed));
    },
  };

  return {
    tabs_list, tabs_create, tabs_close, tabs_activate,
    page_navigate, page_snapshot, page_screenshot,
    page_click, page_type, page_scroll,
    session_release,
  };
}
