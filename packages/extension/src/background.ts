import { Dispatcher } from "./dispatcher.js";
import { WsClient } from "./ws-client.js";
import { registerHandlers } from "./handlers/index.js";
import { derivePairing, getTimezone } from "@browseruse/shared";

const dispatcher = new Dispatcher();
registerHandlers(dispatcher);

async function resolvePairing(): Promise<{ token: string; port: number }> {
  const info = await chrome.runtime.getPlatformInfo();
  const derived = await derivePairing({ timezone: getTimezone(), platform: info.os });
  const { token: overrideToken, port: overridePort } = await chrome.storage.local.get(["token", "port"]);
  const token = typeof overrideToken === "string" && overrideToken.length >= 8 ? overrideToken : derived.token;
  const port =
    typeof overridePort === "number" && overridePort > 0 && overridePort < 65536
      ? overridePort
      : derived.port;
  return { token, port };
}

async function getToken(): Promise<string | null> {
  const { token } = await resolvePairing();
  return token;
}

async function getServerUrl(): Promise<string> {
  const { port } = await resolvePairing();
  return `ws://127.0.0.1:${port}`;
}

/**
 * Stable per-profile identifier. chrome.runtime.id is unique per extension
 * install; since the extension is installed independently in each Chrome
 * profile, the id differs per profile. We hash it so it's opaque and
 * bounded in length. The human-facing label defaults to the Google account
 * email (when `identity` permission is granted) or a user-set override.
 */
async function getIdentity(): Promise<{ profile: string; label: string } | null> {
  try {
    const id = chrome.runtime.id;
    const encoded = new TextEncoder().encode(id);
    const digest = await crypto.subtle.digest("SHA-256", encoded);
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => (b ?? 0).toString(16).padStart(2, "0"))
      .join("");
    const profile = `p-${hex.slice(0, 12)}`;

    // Label: prefer user override (set via popup) > profile tag prefix.
    const { profileLabel } = await chrome.storage.local.get(["profileLabel"]);
    const label =
      typeof profileLabel === "string" && profileLabel.trim()
        ? profileLabel.trim().slice(0, 64)
        : profile.slice(0, 12);
    return { profile, label };
  } catch {
    return null;
  }
}

const client = new WsClient(
  {
    url: getServerUrl,
    getToken,
    getIdentity,
    onStatus: (status) => chrome.storage.local.set({ status }),
  },
  dispatcher
);
client.start();

chrome.runtime.onStartup.addListener(() => client.start());
chrome.runtime.onInstalled.addListener(() => client.start());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.token || changes.port || changes.profileLabel) {
    client.stop();
    client.start();
  }
});

// Keep the MV3 service worker warm: Chrome parks it after ~30s idle.
chrome.alarms.create("browseruse-keepalive", { periodInMinutes: 25 / 60 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "browseruse-keepalive") client.ping();
});
