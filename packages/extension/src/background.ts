import { Dispatcher } from "./dispatcher.js";
import { WsClient } from "./ws-client.js";
import { registerHandlers } from "./handlers/index.js";

const dispatcher = new Dispatcher();
registerHandlers(dispatcher);

async function getToken(): Promise<string | null> {
  const { token } = await chrome.storage.local.get("token");
  return typeof token === "string" && token.length >= 8 ? token : null;
}

const client = new WsClient(
  {
    url: `ws://127.0.0.1:${59321}`,
    getToken,
    onStatus: (status) => chrome.storage.local.set({ status }),
  },
  dispatcher
);
client.start();

chrome.runtime.onStartup.addListener(() => client.start());
chrome.runtime.onInstalled.addListener(() => client.start());
