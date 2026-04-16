import type { Dispatcher } from "../dispatcher.js";
import { SessionClaimParamsSchema, SessionReleaseParamsSchema } from "@browseruse/shared";

let claudeGroupId: number | null = null;
const claimed = new Set<number>();

async function ensureGroup(tabId: number): Promise<number> {
  if (claudeGroupId !== null) {
    try {
      await chrome.tabs.group({ tabIds: [tabId], groupId: claudeGroupId });
      return claudeGroupId;
    } catch {
      claudeGroupId = null;
    }
  }
  const gid = await chrome.tabs.group({ tabIds: [tabId] });
  await chrome.tabGroups.update(gid, { title: "Claude", color: "orange", collapsed: false });
  claudeGroupId = gid;
  return gid;
}

async function injectOverlay(tabId: number) {
  await chrome.scripting
    .executeScript({ target: { tabId }, files: ["src/content/claude-overlay.ts"] })
    .catch(() => { /* some pages block injection; acceptable */ });
}

async function removeOverlay(tabId: number) {
  await chrome.scripting
    .executeScript({
      target: { tabId },
      func: () => { document.querySelector('div[data-browseruse="overlay"]')?.remove(); },
    })
    .catch(() => {});
}

export function registerSessionHandlers(d: Dispatcher) {
  d.register("session.claim", async (raw) => {
    const p = SessionClaimParamsSchema.parse(raw);
    const gid = await ensureGroup(p.tabId);
    claimed.add(p.tabId);
    await injectOverlay(p.tabId);
    return { ok: true as const, groupId: gid };
  });

  d.register("session.release", async (raw) => {
    const p = SessionReleaseParamsSchema.parse(raw);
    try { await chrome.tabs.ungroup([p.tabId]); } catch {}
    claimed.delete(p.tabId);
    await removeOverlay(p.tabId);
    return { ok: true as const };
  });
}
