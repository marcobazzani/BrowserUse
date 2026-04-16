import type { Dispatcher } from "../dispatcher.js";
import { PageSnapshotParamsSchema, PageScreenshotParamsSchema } from "@browseruse/shared";

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

function a11ySnapshot(maxBytes: number) {
  // Simple accessibility tree — role + name + value for focusable / nameable elements.
  // Full AX tree via CDP is a later improvement.
  const nodes: string[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const el = n as HTMLElement;
    const role = el.getAttribute("role") ?? el.tagName.toLowerCase();
    const name =
      el.getAttribute("aria-label") ??
      el.getAttribute("alt") ??
      (el instanceof HTMLInputElement ? (el.placeholder || el.name || "") : "") ??
      "";
    const text = (el.innerText || "").trim().slice(0, 80);
    if (["button", "a", "input", "textarea", "select", "summary"].includes(role) || name || text) {
      nodes.push(`${role}${name ? ` "${name}"` : ""}${text ? ` — ${text}` : ""}`);
    }
  }
  const raw = nodes.join("\n");
  const truncated = raw.length > maxBytes;
  return {
    mode: "a11y" as const,
    url: location.href,
    title: document.title,
    content: truncated ? raw.slice(0, maxBytes) : raw,
    truncated,
  };
}

export function registerPageReadHandlers(d: Dispatcher) {
  d.register("page.snapshot", async (raw) => {
    const p = PageSnapshotParamsSchema.parse(raw);
    const fn = p.mode === "dom" ? domSnapshot : p.mode === "a11y" ? a11ySnapshot : textSnapshot;
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      func: fn,
      args: [p.maxBytes],
    });
    return result;
  });

  d.register("page.screenshot", async (raw) => {
    const p = PageScreenshotParamsSchema.parse(raw);
    const tab = await chrome.tabs.get(p.tabId);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId!, { format: p.format });
    // dataUrl is "data:image/png;base64,XXXX" — strip prefix.
    const comma = dataUrl.indexOf(",");
    const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    return { format: p.format, base64 };
  });
}
