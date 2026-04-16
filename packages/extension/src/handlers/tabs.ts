import type { Dispatcher } from "../dispatcher.js";
import { TabsCreateParamsSchema, TabsCloseParamsSchema, TabsActivateParamsSchema } from "@browseruse/shared";

export function registerTabHandlers(d: Dispatcher) {
  d.register("tabs.list", async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.map((t) => ({
      tabId: t.id!, url: t.url ?? "", title: t.title ?? "",
      active: !!t.active, windowId: t.windowId,
    }));
  });

  d.register("tabs.create", async (raw) => {
    const p = TabsCreateParamsSchema.parse(raw);
    const tab = await chrome.tabs.create({ url: p.url, active: p.active });
    return { tabId: tab.id!, url: tab.url ?? p.url, title: tab.title ?? "", active: !!tab.active, windowId: tab.windowId };
  });

  d.register("tabs.close", async (raw) => {
    const p = TabsCloseParamsSchema.parse(raw);
    await chrome.tabs.remove(p.tabId);
    return { ok: true as const };
  });

  d.register("tabs.activate", async (raw) => {
    const p = TabsActivateParamsSchema.parse(raw);
    await chrome.tabs.update(p.tabId, { active: true });
    return { ok: true as const };
  });
}
