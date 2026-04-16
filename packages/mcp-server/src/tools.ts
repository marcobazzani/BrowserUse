import { z } from "zod";
import {
  TabsListParamsSchema,
  TabsCreateParamsSchema,
  PageNavigateParamsSchema,
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

const claimed = new Set<number>();

/** Exposed for test teardown only — resets the module-level claim set. */
export function _resetClaimedForTest(): void {
  claimed.clear();
}

async function ensureClaim(bridge: BridgeServer, tabId: number) {
  if (claimed.has(tabId)) return;
  await bridge.call("session.claim", { tabId });
  claimed.add(tabId);
}

export function buildTools(bridge: BridgeServer) {
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
      await ensureClaim(bridge, tab.tabId);
      return text(tab);
    },
  };

  const page_navigate: Tool<z.infer<typeof PageNavigateParamsSchema>> = {
    description: "Navigate the given tab to a URL. Auto-claims the tab.",
    inputSchema: PageNavigateParamsSchema,
    handler: async (params) => {
      guard(bridge);
      const parsed = PageNavigateParamsSchema.parse(params);
      await ensureClaim(bridge, parsed.tabId);
      return text(await bridge.call("page.navigate", parsed));
    },
  };

  return { tabs_list, tabs_create, page_navigate };
}
