const statusEl = document.getElementById("status") as HTMLParagraphElement;
const tokenEl = document.getElementById("token") as HTMLInputElement;
const saveEl = document.getElementById("save") as HTMLButtonElement;

async function refresh() {
  const { status, token } = await chrome.storage.local.get(["status", "token"]);
  statusEl.textContent = `Status: ${status ?? "unknown"}${token ? "" : " (no token saved)"}`;
  if (token) tokenEl.placeholder = "token saved; paste to replace";
}

saveEl.addEventListener("click", async () => {
  const t = tokenEl.value.trim();
  if (t.length < 8) { alert("token looks too short"); return; }
  await chrome.storage.local.set({ token: t });
  tokenEl.value = "";
  await refresh();
});

chrome.storage.onChanged.addListener(() => refresh());
refresh();
