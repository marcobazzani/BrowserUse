import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type BrowserContext } from "playwright";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const extDir = resolve(here, "../dist");
const serverEntry = resolve(here, "../../mcp-server/dist/index.js");

const SHOULD_RUN = process.env.BROWSERUSE_E2E === "1";
const describeE2E = SHOULD_RUN ? describe : describe.skip;

describeE2E("end-to-end: extension in real Chromium ↔ real MCP server", () => {
  let server: ChildProcessWithoutNullStreams;
  let ctx: BrowserContext;
  let token: string;

  beforeAll(async () => {
    if (!existsSync(extDir)) throw new Error(`extension not built: ${extDir}`);
    if (!existsSync(serverEntry)) throw new Error(`server not built: ${serverEntry}`);

    server = spawn("node", [serverEntry], { env: { ...process.env, BROWSERUSE_PORT: "59322" } });
    token = await new Promise<string>((resolve) => {
      server.stderr.on("data", (buf) => {
        const m = /Token[^:]*:\s*([a-f0-9]+)/.exec(buf.toString());
        if (m) resolve(m[1]);
      });
    });

    ctx = await chromium.launchPersistentContext("", {
      headless: false,
      args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
    });

    const bg = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
    await bg.evaluate((t) => chrome.storage.local.set({ token: t }), token);
    await new Promise((r) => setTimeout(r, 500));
  }, 30_000);

  afterAll(async () => {
    await ctx?.close();
    server?.kill("SIGTERM");
  });

  it("tabs.list from the MCP server returns the live Chromium tabs", async () => {
    const page = await ctx.newPage();
    await page.goto("https://example.com/");

    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    const transport = new StdioClientTransport({
      command: "node",
      args: [serverEntry],
      env: { ...process.env, BROWSERUSE_PORT: "59322", BROWSERUSE_TOKEN: token },
    });
    await client.connect(transport);
    const result = await client.callTool({ name: "tabs_list", arguments: {} });
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.some((t: any) => String(t.url).startsWith("https://example.com"))).toBe(true);
    await client.close();
  }, 30_000);

  it("page.navigate auto-claims: overlay shadow-DOM appears", async () => {
    const page = await ctx.newPage();
    await page.goto("about:blank");
    const tabId = await page.evaluate(() =>
      new Promise<number>((res) => chrome.tabs?.getCurrent?.((t) => res(t!.id!)))
    ).catch(() => -1);

    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    const transport = new StdioClientTransport({
      command: "node",
      args: [serverEntry],
      env: { ...process.env, BROWSERUSE_PORT: "59322", BROWSERUSE_TOKEN: token },
    });
    await client.connect(transport);
    await client.callTool({ name: "page_navigate", arguments: { tabId, url: "https://example.com/" } });
    await page.waitForURL(/example\.com/);
    const hasOverlay = await page.evaluate(
      () => !!document.querySelector('div[data-browseruse="overlay"]')
    );
    expect(hasOverlay).toBe(true);
    await client.close();
  }, 30_000);
});
