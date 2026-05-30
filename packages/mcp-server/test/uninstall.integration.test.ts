import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../../scripts/uninstall.sh", import.meta.url));

let home: string;
let bin: string;
let commandLog: string;

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

const writeFakeCommand = (name: string) => {
  const path = join(bin, name);
  writeFileSync(path, [
    "#!/usr/bin/env bash",
    `printf '%s %s\\n' "${name}" "$*" >> "${commandLog}"`,
    "exit 0",
    "",
  ].join("\n"));
  chmodSync(path, 0o755);
};

const run = () =>
  execFileSync("bash", [SCRIPT], {
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    },
    encoding: "utf8",
  });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "chromanche-uninstall-home-"));
  bin = mkdtempSync(join(tmpdir(), "chromanche-uninstall-bin-"));
  commandLog = join(home, "commands.log");
  writeFakeCommand("claude");
  writeFakeCommand("codex");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

describe("uninstall.sh", () => {
  it("removes chromanche and legacy browseruse installs and MCP registrations", () => {
    mkdirSync(join(home, ".chromanche", "mcp-server"), { recursive: true });
    mkdirSync(join(home, ".browseruse", "mcp-server"), { recursive: true });

    writeJson(".claude", "settings.json", {
      mcpServers: {
        chromanche: { command: "node" },
        browseruse: { command: "node" },
        keepme: { command: "x" },
      },
    });
    writeJson(".config/opencode", "opencode.json", {
      mcp: {
        chromanche: { type: "local" },
        browseruse: { type: "local" },
        keepme: { type: "local" },
      },
    });
    // Stale config left behind by older installers that wrote to the wrong path.
    writeJson(".opencode", "config.json", {
      mcp: {
        chromanche: { type: "local" },
        browseruse: { type: "local" },
      },
    });
    writeJson(".copilot", "mcp-config.json", {
      mcpServers: {
        chromanche: { type: "stdio" },
        browseruse: { type: "stdio" },
        keepme: { type: "stdio" },
      },
    });
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(codexCfg(), [
      "[mcp_servers.chromanche]",
      'command = "node"',
      'args = ["/new/index.cjs"]',
      "",
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

    expect(existsSync(join(home, ".chromanche"))).toBe(false);
    expect(existsSync(join(home, ".browseruse"))).toBe(false);
    expect(readJson(claudeCfg()).mcpServers).toEqual({ keepme: { command: "x" } });
    expect(readJson(opencodeCfg()).mcp).toEqual({ keepme: { type: "local" } });
    // The legacy path must also be scrubbed so users do not retain a ghost
    // entry that points at a deleted binary.
    expect(readJson(opencodeLegacyCfg())).not.toHaveProperty("mcp");
    expect(readJson(copilotCfg()).mcpServers).toEqual({ keepme: { type: "stdio" } });
    expect(readFileSync(codexCfg(), "utf8")).toBe([
      "[mcp_servers.keepme]",
      'command = "npx"',
      'args = ["-y", "pkg"]',
      "",
    ].join("\n"));
    expect(readFileSync(commandLog, "utf8")).toContain("claude mcp remove chromanche --scope user");
    expect(readFileSync(commandLog, "utf8")).toContain("claude mcp remove browseruse --scope user");
    expect(readFileSync(commandLog, "utf8")).toContain("codex mcp remove chromanche");
    expect(readFileSync(commandLog, "utf8")).toContain("codex mcp remove browseruse");
  });
});
