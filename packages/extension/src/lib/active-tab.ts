export async function resolveTabId(tabId: number | undefined): Promise<number> {
  if (tabId !== undefined) return tabId;
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!t || t.id === undefined) throw new Error("no active tab to target");
  return t.id;
}
