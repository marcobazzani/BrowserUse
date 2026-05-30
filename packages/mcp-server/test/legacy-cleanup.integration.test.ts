import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Drives scripts/cleanup-legacy.sh against a throwaway $HOME seeded with a
 * fake legacy "browseruse" install: an installed dir plus a registered MCP
 * entry in each of the three client configs. Asserts the old name is gone
 * everywhere and unrelated servers survive. No network — only the cleanup
 * path of the installer is exercised.
 */
const SCRIPT = fileURLToPath(new URL("../../../scripts/cleanup-legacy.sh", import.meta.url));

let home: string;

const claudeCfg = () => join(home, ".claude", "settings.json");
const opencodeCfg = () => join(home, ".config", "opencode", "opencode.json");
const opencodeLegacyCfg = () => join(home, ".opencode", "config.json");
const copilotCfg = () => join(home, ".copilot", "mcp-config.json");
const codexCfg = () => join(home, ".codex", "config.toml");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

const writeJson = (relDir: string, file: string, data: unknown) => {
  mkdirSync(join(home, relDir), { recursive: true });
  writeFileSync(join(home, relDir, file), JSON.stringify(data, null, 2));
};

const run = () =>
  execFileSync("bash", [SCRIPT], {
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
    encoding: "utf8",
  });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "chromanche-cleanup-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("cleanup-legacy.sh", () => {
  it("removes the legacy install dir and every browseruse MCP entry", () => {
    mkdirSync(join(home, ".browseruse", "mcp-server"), { recursive: true });
    writeFileSync(join(home, ".browseruse", "token"), "x");

    writeJson(".claude", "settings.json", {
      mcpServers: { browseruse: { command: "node" }, keepme: { command: "x" } },
    });
    writeJson(".config/opencode", "opencode.json", {
      mcp: { browseruse: { type: "local" }, keepme: { type: "local" } },
    });
    // A stale legacy ~/.opencode/config.json from older installers must also
    // be scrubbed so the user does not end up with a half-removed entry.
    writeJson(".opencode", "config.json", {
      mcp: { browseruse: { type: "local" } },
    });
    writeJson(".copilot", "mcp-config.json", {
      mcpServers: { browseruse: { type: "stdio" }, keepme: { type: "stdio" } },
    });
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(codexCfg(), [
      "[mcp_servers.browseruse]",
      'command = "node"',
      'args = ["/old/index.cjs"]',
      "",
      "[mcp_servers.keepme]",
      'command = "npx"',
      'args = ["-y", "pkg"]',
      "",
    ].join("\n"));

    run();

    expect(existsSync(join(home, ".browseruse"))).toBe(false);
    expect(readJson(claudeCfg()).mcpServers).toEqual({ keepme: { command: "x" } });
    expect(readJson(opencodeCfg()).mcp).toEqual({ keepme: { type: "local" } });
    expect(readJson(opencodeLegacyCfg())).not.toHaveProperty("mcp");
    expect(readJson(copilotCfg()).mcpServers).toEqual({ keepme: { type: "stdio" } });
    expect(readFileSync(codexCfg(), "utf8")).toBe([
      "[mcp_servers.keepme]",
      'command = "npx"',
      'args = ["-y", "pkg"]',
      "",
    ].join("\n"));
  });

  it("is a no-op when there is no legacy install", () => {
    writeJson(".claude", "settings.json", { mcpServers: { chromanche: {} } });
    expect(() => run()).not.toThrow();
    expect(readJson(claudeCfg()).mcpServers).toEqual({ chromanche: {} });
  });
});
