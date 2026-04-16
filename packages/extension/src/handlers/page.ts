import type { Dispatcher } from "../dispatcher.js";
import { PageNavigateParamsSchema } from "@browseruse/shared";

function waitForTabLoad(tabId: number, waitUntil: "load" | "domcontentloaded"): Promise<string> {
  return new Promise((resolve) => {
    const listener = (id: number, info: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
      if (id !== tabId) return;
      const ready = waitUntil === "load" ? info.status === "complete" : !!tab.url;
      if (ready) {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab.url ?? "");
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.get(tabId).then((t) => resolve(t.url ?? ""));
    }, 30_000);
  });
}

export function registerPageHandlers(d: Dispatcher) {
  d.register("page.navigate", async (raw) => {
    const p = PageNavigateParamsSchema.parse(raw);
    await chrome.tabs.update(p.tabId, { url: p.url });
    const finalUrl = await waitForTabLoad(p.tabId, p.waitUntil);
    return { ok: true as const, finalUrl };
  });
}
