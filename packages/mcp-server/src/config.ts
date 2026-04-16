import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  port: number;
  timeoutMs: number;
  token: string;
  tokenFile: string;
}

export function loadConfig(): Config {
  const port = Number(process.env.BROWSERUSE_PORT ?? 59321);
  const timeoutMs = Number(process.env.BROWSERUSE_TIMEOUT_MS ?? 20000);
  const token = process.env.BROWSERUSE_TOKEN ?? randomBytes(24).toString("hex");
  const dir = join(homedir(), ".browseruse");
  mkdirSync(dir, { recursive: true });
  const tokenFile = join(dir, "token");
  writeFileSync(tokenFile, token, { encoding: "utf8" });
  chmodSync(tokenFile, 0o600);
  return { port, timeoutMs, token, tokenFile };
}
