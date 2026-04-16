#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { BridgeServer } from "./bridge.js";
import { buildTools } from "./tools.js";
import { loadConfig } from "./config.js";

async function main() {
  const cfg = loadConfig();
  const bridge = new BridgeServer({ token: cfg.token, timeoutMs: cfg.timeoutMs });
  await bridge.listen(cfg.port);
  console.error(
    `[browseruse] listening on ws://127.0.0.1:${cfg.port}. Token (paste into extension popup): ${cfg.token}`
  );

  const tools = buildTools(bridge);
  const server = new Server(
    { name: "browseruse", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(tools).map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: (t.inputSchema as any).toJSON?.() ?? { type: "object" },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const t = (tools as Record<string, (typeof tools)[keyof typeof tools]>)[req.params.name];
    if (!t) throw new Error(`unknown tool ${req.params.name}`);
    return t.handler((req.params.arguments ?? {}) as never);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on("SIGINT", async () => { await bridge.close(); process.exit(0); });
  process.on("SIGTERM", async () => { await bridge.close(); process.exit(0); });
}

main().catch((err) => {
  console.error("[browseruse] fatal:", err);
  process.exit(1);
});
