import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { BridgeServer } from "./bridge.js";
import { buildTools } from "./tools.js";
import { loadConfig } from "./config.js";

async function main() {
  const cfg = await loadConfig();
  const bridge = new BridgeServer({ token: cfg.token, timeoutMs: cfg.timeoutMs });
  await bridge.listen(cfg.port);
  const prefix = cfg.token.slice(0, 8);
  const mode = cfg.derived ? "derived" : "explicit (env)";
  console.error(
    `[browseruse] listening on ws://127.0.0.1:${cfg.port}. Token: ${prefix}... (${mode}; file: ${cfg.tokenFile})`
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
      inputSchema: zodToJsonSchema(t.inputSchema) as Record<string, unknown>,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const t = (tools as Record<string, (typeof tools)[keyof typeof tools]>)[req.params.name];
    if (!t) throw new Error(`unknown tool ${req.params.name}`);
    // Use Parameters<...> for a meaningful cast (rather than `as never`).
    type P = Parameters<NonNullable<typeof t>["handler"]>[0];
    return (t.handler as (p: P) => Promise<{ content: Array<{ type: "text"; text: string }> }>)(
      (req.params.arguments ?? {}) as P
    );
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = () => {
    bridge.close().catch((err) => console.error("[browseruse] close error:", err)).finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[browseruse] fatal:", err);
  process.exit(1);
});
