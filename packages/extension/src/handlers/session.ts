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

// Runs in the target page; must be self-contained (no closures over outer scope).
function overlayIn() {
  if (document.querySelector('div[data-browseruse="overlay"]')) return;
  const host = document.createElement("div");
  host.setAttribute("data-browseruse", "overlay");
  host.style.cssText =
    "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = [
    "<style>",
    "@keyframes browseruse-pulse {",
    "  0%, 100% { box-shadow: inset 0 0 0 4px #FFB020, inset 0 0 24px rgba(255,140,0,0.35); }",
    "  50%      { box-shadow: inset 0 0 0 4px #FF8C00, inset 0 0 32px rgba(255,140,0,0.55); }",
    "}",
    ".frame { position: fixed; inset: 0; pointer-events: none; animation: browseruse-pulse 2s ease-in-out infinite; }",
    ".pill {",
    "  position: fixed; top: 12px; right: 12px; padding: 6px 12px;",
    "  background: #FF8C00; color: white; border-radius: 9999px;",
    "  font: 600 12px/1.2 system-ui, sans-serif; letter-spacing: 0.02em;",
    "  box-shadow: 0 2px 8px rgba(0,0,0,0.2); pointer-events: auto;",
    "}",
    "</style>",
    '<div class="frame"></div>',
    '<div class="pill" title="This tab is being controlled by Claude">Claude is using this tab</div>',
  ].join("\n");
  document.documentElement.appendChild(host);
}

function overlayOut() {
  document.querySelector('div[data-browseruse="overlay"]')?.remove();
}

async function injectOverlay(tabId: number) {
  await chrome.scripting
    .executeScript({ target: { tabId }, func: overlayIn })
    .catch(() => { /* some pages (chrome://, certain CSP) block injection; acceptable */ });
}

async function removeOverlay(tabId: number) {
  await chrome.scripting
    .executeScript({ target: { tabId }, func: overlayOut })
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
