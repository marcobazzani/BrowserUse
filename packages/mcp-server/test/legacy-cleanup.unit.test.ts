import { describe, expect, it } from "vitest";
// Installer helper for editing MCP-client config JSON. Plain .mjs, no types —
// vitest transpiles and runs it directly.
// @ts-expect-error — no type declarations for the .mjs helper
import {
  removeServer,
  addServer,
  removeCodexServerToml,
  addCodexServerToml,
} from "../../../scripts/lib/mcp-config.mjs";

describe("mcp-config removeServer", () => {
  it("removes a server from mcpServers and keeps siblings", () => {
    const input = {
      mcpServers: { browseruse: { command: "node" }, other: { command: "x" } },
    };
    const out = removeServer(input, "browseruse");
    expect(out.mcpServers).toEqual({ other: { command: "x" } });
  });

  it("removes from the OpenCode 'mcp' and legacy 'servers' containers", () => {
    expect(removeServer({ mcp: { browseruse: {}, keep: {} } }, "browseruse"))
      .toEqual({ mcp: { keep: {} } });
    expect(removeServer({ servers: { browseruse: {}, keep: {} } }, "browseruse"))
      .toEqual({ servers: { keep: {} } });
  });

  it("removes the entry from every container it appears in", () => {
    const out = removeServer(
      { mcpServers: { browseruse: {} }, mcp: { browseruse: {}, keep: {} } },
      "browseruse",
    );
    expect(out).toEqual({ mcp: { keep: {} } });
  });

  it("drops a container once its last entry is removed", () => {
    const out = removeServer({ mcpServers: { browseruse: {} } }, "browseruse");
    expect(out).not.toHaveProperty("mcpServers");
  });

  it("leaves config untouched when the name is absent", () => {
    const input = { mcpServers: { other: { command: "x" } }, theme: "dark" };
    expect(removeServer(input, "browseruse")).toEqual(input);
  });

  it("round-trips unknown shapes and never mutates the input", () => {
    expect(removeServer(null, "browseruse")).toBeNull();
    expect(removeServer("nope", "browseruse")).toBe("nope");
    const input = { mcpServers: { browseruse: {} } };
    removeServer(input, "browseruse");
    expect(input.mcpServers).toHaveProperty("browseruse");
  });
});

describe("mcp-config addServer", () => {
  const entry = { command: "node", args: ["/x/index.cjs"] };

  it("adds a server under a new container", () => {
    expect(addServer({}, "mcpServers", "chromanche", entry))
      .toEqual({ mcpServers: { chromanche: entry } });
  });

  it("is idempotent — re-adding the same name overwrites in place", () => {
    const once = addServer({}, "mcpServers", "chromanche", { command: "old" });
    const twice = addServer(once, "mcpServers", "chromanche", entry);
    expect(Object.keys(twice.mcpServers)).toEqual(["chromanche"]);
    expect(twice.mcpServers.chromanche).toEqual(entry);
  });

  it("preserves other servers and top-level keys", () => {
    const out = addServer(
      { mcpServers: { other: {} }, theme: "dark" },
      "mcpServers",
      "chromanche",
      entry,
    );
    expect(out.mcpServers).toEqual({ other: {}, chromanche: entry });
    expect(out.theme).toBe("dark");
  });

  it("creates a fresh object from null/undefined input", () => {
    expect(addServer(null, "mcp", "chromanche", entry))
      .toEqual({ mcp: { chromanche: entry } });
  });
});

describe("mcp-config Codex TOML helpers", () => {
  it("removes only the matching Codex MCP server table", () => {
    const input = [
      'model = "gpt-5"',
      "",
      "[mcp_servers.browseruse]",
      'command = "node"',
      'args = ["/old/index.cjs"]',
      "",
      "[mcp_servers.keepme]",
      'command = "npx"',
      'args = ["-y", "pkg"]',
      "",
      "[features]",
      "memories = true",
      "",
    ].join("\n");

    expect(removeCodexServerToml(input, "browseruse")).toBe([
      'model = "gpt-5"',
      "[mcp_servers.keepme]",
      'command = "npx"',
      'args = ["-y", "pkg"]',
      "",
      "[features]",
      "memories = true",
      "",
    ].join("\n"));
  });

  it("adds or replaces a Codex MCP server table", () => {
    const input = [
      "[mcp_servers.chromanche]",
      'command = "node"',
      'args = ["/old/index.cjs"]',
      "",
      "[features]",
      "memories = true",
      "",
    ].join("\n");

    expect(addCodexServerToml(input, "chromanche", {
      command: "node",
      args: ["/new/index.cjs"],
    })).toBe([
      "[features]",
      "memories = true",
      "",
      "[mcp_servers.chromanche]",
      'command = "node"',
      'args = ["/new/index.cjs"]',
      "",
    ].join("\n"));
  });

  it("quotes Codex MCP server names when TOML requires it", () => {
    expect(addCodexServerToml("", "my server", { command: "node", args: ["/x"] }))
      .toContain('[mcp_servers."my server"]');
  });
});
