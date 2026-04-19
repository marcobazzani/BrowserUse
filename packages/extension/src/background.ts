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
 * Stable per-profile identifier.
 *
 * We cannot use chrome.runtime.id: for unpacked extensions Chrome derives the
 * extension ID from the ON-DISK path of the unpacked folder, not per-profile.
 * Two Chrome profiles that "Load unpacked" the same /dist directory end up
 * sharing an extension ID — which would collapse them into one bridge slot
 * and cause takeover flicker.
 *
 * Preferred: chrome.identity.getProfileUserInfo() returns the Chrome profile's
 * signed-in Google account (email + stable Gaia ID). That's Chrome-provided,
 * distinct per profile, and gives us a readable label for free.
 *
 * Fallback: a random tag minted on first run, persisted in
 * chrome.storage.local (which IS profile-scoped). Used for guest / not-signed-
 * in profiles where getProfileUserInfo returns empty.
 *
 * Either way, the user-set label from the popup takes priority over the
 * auto-derived label.
 */
async function getIdentity(): Promise<{ profile: string; label: string } | null> {
  try {
    const stored = await chrome.storage.local.get(["profileTag", "profileLabel"]);

    // First: ask Chrome for the signed-in profile's account info.
    let accountEmail = "";
    let accountId = "";
    try {
      const info = await new Promise<chrome.identity.ProfileUserInfo | undefined>((resolve) => {
        chrome.identity.getProfileUserInfo((i) => resolve(i));
      });
      accountEmail = info?.email ?? "";
      accountId = info?.id ?? "";
    } catch {
      // identity permission missing, or API unavailable — fall through to random UUID.
    }

    let profile: string;
    if (accountId) {
      // Chrome-provided, distinct per profile, stable. Prefix distinguishes
      // it from the random fallback.
      profile = `g-${accountId.slice(0, 16)}`;
    } else {
      // Fallback: random tag stored in profile-scoped storage. Mint on first run.
      if (typeof stored.profileTag === "string" && stored.profileTag.length >= 10) {
        profile = stored.profileTag;
      } else {
        const random = crypto.getRandomValues(new Uint8Array(8));
        const hex = Array.from(random).map((b) => b.toString(16).padStart(2, "0")).join("");
        profile = `p-${hex}`;
        await chrome.storage.local.set({ profileTag: profile });
      }
    }

    // Label: user override > account email > tag prefix.
    const label =
      typeof stored.profileLabel === "string" && stored.profileLabel.trim()
        ? stored.profileLabel.trim().slice(0, 64)
        : accountEmail || profile.slice(0, 12);

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
