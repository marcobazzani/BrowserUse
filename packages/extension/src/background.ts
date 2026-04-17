import { Dispatcher } from "./dispatcher.js";
import { WsClient } from "./ws-client.js";
import { registerHandlers } from "./handlers/index.js";
import { derivePairing, getTimezone } from "@browseruse/shared";

const dispatcher = new Dispatcher();
registerHandlers(dispatcher);

/**
 * Resolve {token, port} for this session. Default path is zero-config:
 * both sides derive the same values from {timezone, platform}. Users who
 * need to override (conflict with another service, multi-user workstation)
 * can still paste an override token and/or custom port into the popup.
 */
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

const client = new WsClient(
  {
    url: getServerUrl,
    getToken,
    onStatus: (status) => chrome.storage.local.set({ status }),
  },
  dispatcher
);
client.start();

chrome.runtime.onStartup.addListener(() => client.start());
chrome.runtime.onInstalled.addListener(() => client.start());

// Restart the WS client when the popup saves an override.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.token || changes.port) {
    client.stop();
    client.start();
  }
});

// Keep the MV3 service worker warm: Chrome parks it after ~30s idle.
chrome.alarms.create("browseruse-keepalive", { periodInMinutes: 25 / 60 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "browseruse-keepalive") client.ping();
});
