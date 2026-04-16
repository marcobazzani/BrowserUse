import { randomBytes } from "node:crypto";
import { mkdirSync, openSync, writeSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  port: number;
  timeoutMs: number;
  token: string;
  tokenFile: string;
}

function parsePort(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? fallback : Number(raw);
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

export function loadConfig(): Config {
  const port = parsePort(process.env.BROWSERUSE_PORT, 59321);
  // 20s is long for interactive use but page.navigate must wait for slow loads.
  const timeoutMs = parsePositiveMs(process.env.BROWSERUSE_TIMEOUT_MS, 20000);
  const token = process.env.BROWSERUSE_TOKEN ?? randomBytes(24).toString("hex");
  const dir = join(homedir(), ".browseruse");
  mkdirSync(dir, { recursive: true });
  const tokenFile = join(dir, "token");
  // Open with mode 0o600 atomically so there is no window where the file
  // is world-readable between create and chmod.
  const fd = openSync(tokenFile, "w", 0o600);
  try {
    writeSync(fd, token);
  } finally {
    closeSync(fd);
  }
  return { port, timeoutMs, token, tokenFile };
}
