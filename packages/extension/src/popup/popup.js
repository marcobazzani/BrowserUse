// Popup: shows connection status + pairing info; overrides only used if user has
// manually configured BROWSERUSE_TOKEN / BROWSERUSE_PORT on the server side.

const statusEl = document.getElementById("status");
const pairingEl = document.getElementById("pairing");
const tokenEl = document.getElementById("token");
const portEl = document.getElementById("port");
const saveEl = document.getElementById("save");
const clearEl = document.getElementById("clear");

const SALT = "browseruse-bridge-v1";

function normalizePlatform(input) {
  const s = String(input).toLowerCase();
  if (s === "darwin" || s === "mac") return "mac";
  if (s === "win32" || s === "win" || s === "windows") return "win";
  if (s === "cros" || s === "chromeos") return "cros";
  if (s === "linux" || s === "openbsd" || s === "freebsd" || s === "sunos" || s === "aix") return "linux";
  return "other";
}

async function sha256Hex(data) {
  const buf = new TextEncoder().encode(data);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function deriveLocal() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const info = await chrome.runtime.getPlatformInfo();
  const platform = normalizePlatform(info.os);
  const token = await sha256Hex(`${tz}|${platform}|${SALT}`);
  const port = 50000 + (parseInt(token.slice(0, 8), 16) % 10000);
  return { token, port, tz, platform };
}

async function refresh() {
  const { status, token: overrideToken, port: overridePort } = await chrome.storage.local.get([
    "status",
    "token",
    "port",
  ]);
  const derived = await deriveLocal();
  const effToken = overrideToken || derived.token;
  const effPort = overridePort || derived.port;

  statusEl.textContent = `Status: ${status ?? "unknown"}`;
  pairingEl.textContent =
    `Pairing: ${overrideToken ? "override" : "auto"} · port ${effPort} · token ${effToken.slice(0, 8)}… (tz=${derived.tz}, ${derived.platform})`;

  portEl.value = typeof overridePort === "number" ? String(overridePort) : "";
  tokenEl.value = typeof overrideToken === "string" ? overrideToken : "";
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
  await refresh();
});

clearEl.addEventListener("click", async () => {
  await chrome.storage.local.remove(["token", "port"]);
  await refresh();
});

chrome.storage.onChanged.addListener(() => refresh());
refresh();
