const statusEl = document.getElementById("status");
const tokenEl = document.getElementById("token");
const portEl = document.getElementById("port");
const saveEl = document.getElementById("save");

async function refresh() {
  const { status, token, port } = await chrome.storage.local.get(["status", "token", "port"]);
  statusEl.textContent = `Status: ${status ?? "unknown"}${token ? "" : " (no token saved)"}`;
  if (token) tokenEl.placeholder = "token saved; paste to replace";
  if (typeof port === "number") portEl.value = String(port);
}

saveEl.addEventListener("click", async () => {
  const t = tokenEl.value.trim();
  const portStr = portEl.value.trim();
  const port = portStr === "" ? undefined : Number(portStr);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    alert("Port must be an integer between 1 and 65535");
    return;
  }
  const updates = {};
  if (t.length >= 8) updates.token = t;
  else if (t.length > 0) { alert("token looks too short"); return; }
  if (port !== undefined) updates.port = port;
  if (Object.keys(updates).length === 0) { alert("nothing to save"); return; }
  await chrome.storage.local.set(updates);
  tokenEl.value = "";
  await refresh();
});

chrome.storage.onChanged.addListener(() => refresh());
refresh();
