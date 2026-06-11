import type { Dispatcher } from "../dispatcher.js";
import { PageWaitForDownloadParamsSchema } from "@chromanche/shared";

/**
 * Observational download capture. The file is the USER's download, landing
 * wherever the user's Chrome already puts it — we never redirect it (no CDP
 * Page.setDownloadBehavior) and never enumerate history (no
 * chrome.downloads.search baseline). Per CLAUDE.md's data-residency
 * principle we react only to downloads created AFTER this wait is armed.
 */
export function registerDownloadHandlers(d: Dispatcher) {
  d.register("page.waitForDownload", async (raw) => {
    const p = PageWaitForDownloadParamsSchema.parse(raw);
    const filenameRe = p.filenamePattern ? new RegExp(p.filenamePattern) : undefined;
    // Ids created after arming. We never look at pre-existing downloads.
    const armedIds = new Set<number>();

    return await new Promise((resolve, reject) => {
      let settled = false;
      const onCreated = (item: chrome.downloads.DownloadItem) => {
        armedIds.add(item.id);
      };
      const onChanged = (delta: chrome.downloads.DownloadDelta) => {
        if (settled) return;
        if (!armedIds.has(delta.id)) return; // only downloads armed after we started
        if (delta.state?.current !== "complete") return;
        chrome.downloads.search({ id: delta.id }, (items) => {
          if (settled) return;
          const item = items[0];
          if (!item) return;
          const filename = item.filename.split(/[/\\]/).pop() ?? item.filename;
          if (filenameRe && !filenameRe.test(filename)) return; // not the one we want; keep waiting
          finish();
          resolve({
            ok: true as const,
            filename,
            path: item.filename,
            bytes: item.fileSize > 0 ? item.fileSize : undefined,
            mime: item.mime || undefined,
            finalUrl: item.finalUrl || item.url || undefined,
          });
        });
      };
      function finish() {
        settled = true;
        clearTimeout(timer);
        chrome.downloads.onCreated.removeListener(onCreated);
        chrome.downloads.onChanged.removeListener(onChanged);
      }
      const timer = setTimeout(() => {
        if (settled) return;
        finish();
        reject(new Error(`page.waitForDownload timed out after ${p.timeoutMs}ms`));
      }, p.timeoutMs);

      chrome.downloads.onCreated.addListener(onCreated);
      chrome.downloads.onChanged.addListener(onChanged);
    });
  });
}
