/**
 * Deterministic pairing derivation: same algorithm runs on both sides
 * (Node.js MCP server and Chrome extension service worker).
 *
 * Goal: zero-config pairing — no paste, no port flag, no token file.
 * Inputs are observable identically in both environments:
 *   - IANA timezone via Intl.DateTimeFormat().resolvedOptions().timeZone
 *   - normalized platform name (mac/linux/win/cros/other)
 *   - a static salt baked into the library version
 *
 * Security model:
 *   - the server binds 127.0.0.1 only, so remote attackers cannot reach it
 *   - the derived key is NOT a cryptographic secret against a local attacker
 *     who can already read any file the user owns (and could simply run this
 *     same library to compute the key); it protects against accidental
 *     localhost clashes (other services on the same port) and cross-origin
 *     web pages that don't know the protocol
 *   - users who need stronger auth can still set BROWSERUSE_TOKEN explicitly
 */

const SALT = "browseruse-bridge-v1";

/** Normalize platform strings across Node (os.platform()) and Chrome (runtime.getPlatformInfo().os). */
export function normalizePlatform(input: string): "mac" | "linux" | "win" | "cros" | "other" {
  const s = input.toLowerCase();
  if (s === "darwin" || s === "mac") return "mac";
  if (s === "win32" || s === "win" || s === "windows") return "win";
  if (s === "cros" || s === "chromeos") return "cros";
  if (s === "linux" || s === "openbsd" || s === "freebsd" || s === "sunos" || s === "aix") return "linux";
  return "other";
}

/** Get the IANA timezone — identical in Node and browser. */
export function getTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Hash a UTF-8 string with SHA-256 → lowercase hex. Uses Web Crypto (available in Node 18+ and all browsers). */
async function sha256Hex(data: string): Promise<string> {
  const buf = new TextEncoder().encode(data);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  }
  return hex;
}

/** Derive a stable pairing key from {timezone, platform, salt}. */
export async function derivePairingKey(timezone: string, platform: string): Promise<string> {
  const normalized = normalizePlatform(platform);
  return sha256Hex(`${timezone}|${normalized}|${SALT}`);
}

/** Derive a stable TCP port from the first 32 bits of the pairing key. Range: [50000, 59999]. */
export function derivePort(pairingKey: string): number {
  const n = parseInt(pairingKey.slice(0, 8), 16);
  return 50000 + (n % 10000);
}

/** Convenience: derive both key and port from whatever each side can read locally. */
export async function derivePairing(opts: { timezone: string; platform: string }): Promise<{
  token: string;
  port: number;
}> {
  const token = await derivePairingKey(opts.timezone, opts.platform);
  const port = derivePort(token);
  return { token, port };
}
