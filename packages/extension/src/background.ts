import { Dispatcher } from "./dispatcher.js";
import { WsClient } from "./ws-client.js";
import { registerHandlers } from "./handlers/index.js";

const dispatcher = new Dispatcher();
registerHandlers(dispatcher);

async function getToken(): Promise<string | null> {
  const { token } = await chrome.storage.local.get("token");
  return typeof token === "string" && token.length >= 8 ? token : null;
}

async function getServerUrl(): Promise<string> {
  const { port } = await chrome.storage.local.get("port");
  const n = typeof port === "number" && port > 0 && port < 65536 ? port : 59321;
  return `ws://127.0.0.1:${n}`;
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

// Restart the WS client when the popup saves a new token or port.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.token || changes.port) {
    client.stop();
    client.start();
  }
});

// Keep the MV3 service worker warm: Chrome parks it after ~30s idle.
// A 25s alarm pings the MCP server over the existing WS; receiving any event
// (including the alarm itself) resets Chrome's idle timer on our side.
chrome.alarms.create("browseruse-keepalive", { periodInMinutes: 25 / 60 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "browseruse-keepalive") client.ping();
});
