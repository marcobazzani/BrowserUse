// Pure helpers for editing MCP-client config JSON (Claude Code / OpenCode /
// GitHub Copilot CLI). Used by the installer to drop a legacy "browseruse"
// registration without disturbing other servers.
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

// --- CLI -------------------------------------------------------------------
// Usage: node mcp-config.mjs remove <config-file> <server-name>
//   Rewrites <config-file> in place with <server-name> removed. A missing
//   file is a no-op (exit 0) so the installer can call it unconditionally.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, file, name] = process.argv.slice(2);
  if (cmd !== "remove" || !file || !name) {
    console.error("usage: mcp-config.mjs remove <config-file> <server-name>");
    process.exit(2);
  }
  const { readFileSync, writeFileSync, existsSync } = await import("node:fs");
  if (!existsSync(file)) process.exit(0);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    console.error(`mcp-config: ${file} is not valid JSON — left untouched.`);
    process.exit(0);
  }
  writeFileSync(file, JSON.stringify(removeServer(parsed, name), null, 2) + "\n");
}
