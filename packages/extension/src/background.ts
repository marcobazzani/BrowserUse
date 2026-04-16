import { Dispatcher } from "./dispatcher.js";
import { WsClient } from "./ws-client.js";

const dispatcher = new Dispatcher();

// Handler stubs — filled in Task 6.
dispatcher.register("tabs.list", async () => {
  const tabs = await chrome.tabs.query({});
  return tabs.map((t) => ({
    tabId: t.id!,
    url: t.url ?? "",
    title: t.title ?? "",
    active: !!t.active,
    windowId: t.windowId,
  }));
});

async function getToken(): Promise<string | null> {
  const { token } = await chrome.storage.local.get("token");
  return typeof token === "string" && token.length >= 8 ? token : null;
}

const client = new WsClient(
  {
    url: "ws://127.0.0.1:59321",
    getToken,
    onStatus: (status) => chrome.storage.local.set({ status }),
  },
  dispatcher
);
client.start();

// Wake-up resilience: re-start on service-worker cold boot.
chrome.runtime.onStartup.addListener(() => client.start());
chrome.runtime.onInstalled.addListener(() => client.start());
