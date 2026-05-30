import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Drives scripts/install.sh against a throwaway $HOME with the download path
 * short-circuited via CHROMANCHE_INSTALL_OFFLINE. We seed a fake "release"
 * directory containing only what the installer needs to find (the MCP entry
 * file); the rest of the script — Claude/Codex/OpenCode/Copilot registration —
 * runs unchanged.
 *
 * Why this matters: the OpenCode registration path was previously writing to
 * ~/.opencode/config.json, a location OpenCode never reads. This test pins it
 * to the canonical XDG path so the bug cannot recur.
 */
const SCRIPT = fileURLToPath(new URL("../../../scripts/install.sh", import.meta.url));

let home: string;
let bin: string;
let offline: string;
let commandLog: string;

const opencodeCfg = () => join(home, ".config", "opencode", "opencode.json");
const opencodeLegacyCfg = () => join(home, ".opencode", "config.json");
const copilotCfg = () => join(home, ".copilot", "mcp-config.json");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

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

const linkRealCommand = (name: string) => {
  // Resolve once via the host's PATH then symlink into bin/ so the installer
  // can find it without us inheriting the rest of process.env.PATH (which
  // could contain a real `opencode`/`claude` and break absence assertions).
  const resolved = execFileSync("bash", ["-lc", `command -v ${name}`], { encoding: "utf8" }).trim();
  if (!resolved) throw new Error(`Required host tool not found: ${name}`);
  symlinkSync(resolved, join(bin, name));
};

const run = (extraEnv: Record<string, string> = {}) =>
  execFileSync("bash", [SCRIPT], {
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      // Pin PATH to bin/ + system dirs only. Inheriting process.env.PATH
      // would expose any real `opencode`/`claude` installed on the dev
      // machine and defeat the "CLI absent" assertions.
      PATH: `${bin}:/usr/bin:/bin`,
      CHROMANCHE_INSTALL_OFFLINE: offline,
      ...extraEnv,
    },
    encoding: "utf8",
  });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "chromanche-install-home-"));
  bin = mkdtempSync(join(tmpdir(), "chromanche-install-bin-"));
  offline = mkdtempSync(join(tmpdir(), "chromanche-install-offline-"));
  commandLog = join(home, "commands.log");

  // The installer hard-requires these on PATH. Symlink the host's copies
  // into our pinned bin/ so we can drop the rest of process.env.PATH.
  for (const tool of ["node", "jq"]) linkRealCommand(tool);

  // Lay out a minimal offline "release": the installer only checks that
  // mcp-server/dist/index.cjs exists. Extension dir is optional but cheap.
  mkdirSync(join(offline, "mcp-server", "dist"), { recursive: true });
  writeFileSync(join(offline, "mcp-server", "dist", "index.cjs"), "// fake mcp entrypoint\n");
  mkdirSync(join(offline, "extension"), { recursive: true });
  writeFileSync(join(offline, "extension", "manifest.json"), "{}\n");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
  rmSync(offline, { recursive: true, force: true });
});

describe("install.sh OpenCode registration", () => {
  it("writes to the XDG path ~/.config/opencode/opencode.json — not the legacy ~/.opencode/config.json", () => {
    // Fake CLIs so the corresponding registration branches run; the OpenCode
    // branch is the one under test but we exercise the whole installer path.
    writeFakeCommand("opencode");
    writeFakeCommand("claude");
    writeFakeCommand("codex");

    run();

    const entry = join(home, ".chromanche", "mcp-server", "dist", "index.cjs");
    expect(existsSync(entry)).toBe(true);

    // XDG path: present and correctly populated.
    expect(existsSync(opencodeCfg())).toBe(true);
    const cfg = readJson(opencodeCfg());
    expect(cfg.mcp).toEqual({
      chromanche: {
        type: "local",
        command: ["node", entry],
        enabled: true,
      },
    });
    // $schema is set so users get IDE validation out of the box.
    expect(cfg.$schema).toBe("https://opencode.ai/config.json");

    // Legacy path must not be created by a fresh install.
    expect(existsSync(opencodeLegacyCfg())).toBe(false);
  });

  it("preserves unrelated keys and other MCP servers in an existing XDG config", () => {
    writeFakeCommand("opencode");
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(opencodeCfg(), JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: "anthropic/claude-opus-4-20250514",
      mcp: {
        other: { type: "local", command: ["node", "/x/y.cjs"], enabled: true },
      },
    }, null, 2));

    run();

    const cfg = readJson(opencodeCfg());
    expect(cfg.model).toBe("anthropic/claude-opus-4-20250514");
    expect(cfg.mcp.other).toEqual({
      type: "local",
      command: ["node", "/x/y.cjs"],
      enabled: true,
    });
    expect(cfg.mcp.chromanche.type).toBe("local");
    expect(cfg.mcp.chromanche.enabled).toBe(true);
  });

  it("scrubs a stale chromanche entry from the legacy ~/.opencode/config.json", () => {
    writeFakeCommand("opencode");
    // Simulate the buggy state earlier installers left users in.
    mkdirSync(join(home, ".opencode"), { recursive: true });
    writeFileSync(opencodeLegacyCfg(), JSON.stringify({
      mcp: {
        chromanche: { type: "local", command: ["node", "/stale/index.cjs"], enabled: true },
      },
    }, null, 2));

    run();

    // Legacy file still exists (we do not delete the file itself, only the
    // entry) but no longer claims a chromanche server.
    expect(existsSync(opencodeLegacyCfg())).toBe(true);
    expect(readJson(opencodeLegacyCfg())).not.toHaveProperty("mcp");
    // New entry written at the real path.
    expect(readJson(opencodeCfg()).mcp.chromanche.type).toBe("local");
  });

  it("skips OpenCode registration entirely when the opencode CLI is absent", () => {
    // No opencode binary on PATH.
    writeFakeCommand("claude");

    run();

    expect(existsSync(opencodeCfg())).toBe(false);
    expect(existsSync(opencodeLegacyCfg())).toBe(false);
  });

  it("registers a stdio entry for GitHub Copilot CLI under mcpServers (camelCase)", () => {
    // Sibling smoke test — guards against a regression where the Copilot
    // shape silently drifts back to .servers (its old, invalid schema).
    writeFakeCommand("copilot");

    run();

    expect(existsSync(copilotCfg())).toBe(true);
    const cfg = readJson(copilotCfg());
    expect(cfg.mcpServers.chromanche.type).toBe("stdio");
    expect(cfg.mcpServers.chromanche.command).toBe("node");
    expect(cfg).not.toHaveProperty("servers");
  });
});
