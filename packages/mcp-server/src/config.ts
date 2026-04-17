import { mkdirSync, openSync, writeSync, closeSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { derivePairing, getTimezone } from "@browseruse/shared";

export interface Config {
  port: number;
  timeoutMs: number;
  token: string;
  tokenFile: string;
  /** True when the token was derived (zero-config pairing) rather than explicit. */
  derived: boolean;
}

function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > 65535) {
    throw new Error(`BROWSERUSE_PORT is not a valid TCP port: ${raw}`);
  }
  return n;
}

function parsePositiveMs(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`BROWSERUSE_TIMEOUT_MS is not a positive number: ${raw}`);
  }
  return n;
}

/**
 * Load config, defaulting token+port to values derived from a stable fingerprint
 * (timezone + normalized platform). The extension computes the same values
 * independently, so pairing is zero-config. Env vars still override.
 */
export async function loadConfig(): Promise<Config> {
  const derived = await derivePairing({ timezone: getTimezone(), platform: platform() });
  const port = parsePort(process.env.BROWSERUSE_PORT) ?? derived.port;
  const timeoutMs = parsePositiveMs(process.env.BROWSERUSE_TIMEOUT_MS, 20000);
  const envToken = process.env.BROWSERUSE_TOKEN;
  const token = envToken ?? derived.token;
  const isDerived = !envToken;

  // Persist the token to disk so operators can inspect/override with an editor
  // even in derived mode. Mode 0o600 atomically (no world-readable window).
  const dir = join(homedir(), ".browseruse");
  mkdirSync(dir, { recursive: true });
  const tokenFile = join(dir, "token");
  const fd = openSync(tokenFile, "w", 0o600);
  try {
    writeSync(fd, token);
  } finally {
    closeSync(fd);
  }
  return { port, timeoutMs, token, tokenFile, derived: isDerived };
}
