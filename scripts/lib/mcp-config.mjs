// Pure helpers for editing MCP-client config (Claude Code / OpenCode /
// GitHub Copilot CLI JSON, Codex TOML). Used by the installer to drop a
// legacy "browseruse" registration without disturbing other servers.
//
// Why node and not jq/sed: node is already a hard dependency of the MCP
// server, jq is not always present, and sed cannot edit JSON safely.

// Containers an MCP server entry may live under, across the three clients we
// support. OpenCode nests under "mcp"; Claude Code / Copilot CLI use
// "mcpServers"; "servers" is a legacy Copilot shape we still clean up.
export const SERVER_CONTAINERS = ["mcpServers", "servers", "mcp"];

/**
 * Return a copy of `json` with the server named `name` removed from every
 * known container. Empties out a container object once its last entry is
 * gone. Never throws on unexpected shapes — unknown JSON round-trips intact.
 */
export function removeServer(json, name) {
  if (json === null || typeof json !== "object") return json;
  const out = structuredClone(json);
  for (const container of SERVER_CONTAINERS) {
    const bag = out[container];
    if (bag && typeof bag === "object" && !Array.isArray(bag) && name in bag) {
      delete bag[name];
      if (Object.keys(bag).length === 0) delete out[container];
    }
  }
  return out;
}

/**
 * Return a copy of `json` with `entry` registered as `name` under `container`
 * (creating the container if needed). Idempotent: re-adding the same name
 * overwrites in place rather than duplicating.
 */
export function addServer(json, container, name, entry) {
  const base = json && typeof json === "object" ? structuredClone(json) : {};
  if (!base[container] || typeof base[container] !== "object") {
    base[container] = {};
  }
  base[container][name] = entry;
  return base;
}

function tomlTableName(name) {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
}

function isTomlTableLine(line) {
  return /^\s*\[[^\]]+\]\s*(?:#.*)?$/.test(line);
}

function isMcpServerTable(line, name) {
  const match = line.match(/^\s*\[mcp_servers\.(.+)\]\s*(?:#.*)?$/);
  if (!match) return false;
  const tableName = match[1].trim();
  return tableName === name || tableName === JSON.stringify(name);
}

/**
 * Return TOML with the `[mcp_servers.<name>]` table removed. This deliberately
 * edits only the table shape Codex writes for stdio MCP servers and leaves the
 * rest of the config byte-for-byte intact.
 */
export function removeCodexServerToml(toml, name) {
  const lines = String(toml ?? "").split("\n");
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (skipping && isTomlTableLine(line)) skipping = false;
    if (!skipping && isMcpServerTable(line, name)) {
      skipping = true;
      if (out[out.length - 1] === "") out.pop();
      continue;
    }
    if (!skipping) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Return TOML with Codex stdio MCP server `name` added or replaced.
 */
export function addCodexServerToml(toml, name, entry) {
  const base = removeCodexServerToml(toml, name).replace(/\s*$/, "");
  const args = Array.isArray(entry.args) ? entry.args : [];
  const block = [
    `[mcp_servers.${tomlTableName(name)}]`,
    `command = ${JSON.stringify(entry.command)}`,
    `args = [${args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
  ].join("\n");
  return `${base}${base ? "\n\n" : ""}${block}\n`;
}

// --- CLI -------------------------------------------------------------------
// Usage:
//   node mcp-config.mjs remove <json-file> <server-name>
//   node mcp-config.mjs remove-codex <toml-file> <server-name>
//   node mcp-config.mjs add-codex <toml-file> <server-name> <entrypoint>
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, file, name, entrypoint] = process.argv.slice(2);
  if (!cmd || !file || !name) {
    console.error("usage: mcp-config.mjs remove <json-file> <server-name>");
    console.error("       mcp-config.mjs remove-codex <toml-file> <server-name>");
    console.error("       mcp-config.mjs add-codex <toml-file> <server-name> <entrypoint>");
    process.exit(2);
  }
  const { readFileSync, writeFileSync, existsSync, mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");

  if (cmd === "remove") {
    if (!existsSync(file)) process.exit(0);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      console.error(`mcp-config: ${file} is not valid JSON — left untouched.`);
      process.exit(0);
    }
    writeFileSync(file, JSON.stringify(removeServer(parsed, name), null, 2) + "\n");
  } else if (cmd === "remove-codex") {
    if (!existsSync(file)) process.exit(0);
    writeFileSync(file, removeCodexServerToml(readFileSync(file, "utf8"), name));
  } else if (cmd === "add-codex") {
    if (!entrypoint) {
      console.error("usage: mcp-config.mjs add-codex <toml-file> <server-name> <entrypoint>");
      process.exit(2);
    }
    mkdirSync(dirname(file), { recursive: true });
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    writeFileSync(file, addCodexServerToml(current, name, { command: "node", args: [entrypoint] }));
  } else {
    console.error(`mcp-config: unknown command ${cmd}`);
    process.exit(2);
  }
}
