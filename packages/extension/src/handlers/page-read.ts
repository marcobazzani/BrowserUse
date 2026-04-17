import type { Dispatcher } from "../dispatcher.js";
import { PageSnapshotParamsSchema, PageScreenshotParamsSchema } from "@browseruse/shared";
import { resolveTabId } from "../lib/active-tab.js";
import { captureA11ySnapshot } from "../lib/snapshot-manager.js";
import type { DebuggerManager } from "../lib/debugger-manager.js";

/** Shared helper: produce an a11y snapshot string for a tab. Used by interaction handlers too. */
export async function takeA11ySnapshot(mgr: DebuggerManager, tabId: number, maxBytes = 80_000): Promise<string> {
  const { content } = await captureA11ySnapshot(mgr, tabId, maxBytes);
  return content;
}

// Runs in-page. Must be self-contained (no closures).
function textSnapshot(maxBytes: number) {
  const raw = document.body?.innerText ?? "";
  const truncated = raw.length > maxBytes;
  return {
    mode: "text" as const,
    url: location.href,
    title: document.title,
    content: truncated ? raw.slice(0, maxBytes) : raw,
    truncated,
  };
}

function domSnapshot(maxBytes: number) {
  const raw = document.documentElement.outerHTML;
  const truncated = raw.length > maxBytes;
  return {
    mode: "dom" as const,
    url: location.href,
    title: document.title,
    content: truncated ? raw.slice(0, maxBytes) : raw,
    truncated,
  };
}

export function registerPageReadHandlers(d: Dispatcher, mgr: DebuggerManager) {
  d.register("page.snapshot", async (raw) => {
    const p = PageSnapshotParamsSchema.parse(raw);
    const tabId = await resolveTabId(p.tabId);

    if (p.mode === "a11y") {
      const { content, truncated } = await captureA11ySnapshot(mgr, tabId, p.maxBytes);
      const tab = await chrome.tabs.get(tabId);
      return {
        mode: "a11y" as const,
        url: tab.url ?? "",
        title: tab.title ?? "",
        content,
        truncated,
      };
    }

    const fn = p.mode === "dom" ? domSnapshot : textSnapshot;
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: fn,
      args: [p.maxBytes],
    });
    return result;
  });

  d.register("page.screenshot", async (raw) => {
    const p = PageScreenshotParamsSchema.parse(raw);
    const tabId = await resolveTabId(p.tabId);
    const tab = await chrome.tabs.get(tabId);
    const opts: chrome.tabs.CaptureVisibleTabOptions =
      p.format === "jpeg" ? { format: "jpeg", quality: p.quality } : { format: "png" };
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId!, opts);
    const comma = dataUrl.indexOf(",");
    const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    return { format: p.format, base64 };
  });
}
