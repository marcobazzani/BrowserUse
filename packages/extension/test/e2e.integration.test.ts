import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type BrowserContext, type Worker } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const extDir = resolve(here, "../dist");
const serverEntry = resolve(here, "../../mcp-server/dist/index.js");

const SHOULD_RUN = process.env.BROWSERUSE_E2E === "1";
const describeE2E = SHOULD_RUN ? describe : describe.skip;

const PORT = "59322";
const TOKEN = randomBytes(24).toString("hex");

async function setExtensionStorage(sw: Worker, data: Record<string, unknown>) {
  // Retry until chrome.storage is wired up; the SW may still be booting.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await sw.evaluate(async (payload) => {
        if (typeof chrome === "undefined" || !chrome.storage?.local) throw new Error("chrome.storage unavailable");
        await chrome.storage.local.set(payload);
      }, data);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("timed out waiting for chrome.storage.local in extension SW");
}

async function waitForAuthed(sw: Worker, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await sw.evaluate(async () => {
      const r = await chrome.storage.local.get("status");
      return r.status as string | undefined;
    }).catch(() => undefined);
    if (status === "authed") return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("extension did not reach status=authed in time");
}

describeE2E("end-to-end: extension in real Chromium ↔ real MCP server", () => {
  let ctx: BrowserContext;
  let sw: Worker;
  let mcpClient: { callTool: (req: { name: string; arguments: unknown }) => Promise<{ content: Array<{ text: string }> }>; close: () => Promise<void> };

  beforeAll(async () => {
    if (!existsSync(extDir)) throw new Error(`extension not built: ${extDir}`);
    if (!existsSync(serverEntry)) throw new Error(`server not built: ${serverEntry}`);

    // Launch Chromium with extension + persistent context.
    ctx = await chromium.launchPersistentContext("", {
      headless: false,
      args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
    });

    // Grab the extension's service worker.
    sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));

    // Pre-seed token + port BEFORE the server starts (so the extension can auth on first connect).
    await setExtensionStorage(sw, { token: TOKEN, port: Number(PORT) });

    // Spawn the ONE MCP server via the MCP SDK's stdio client.
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    const transport = new StdioClientTransport({
      command: "node",
      args: [serverEntry],
      env: { ...process.env, BROWSERUSE_PORT: PORT, BROWSERUSE_TOKEN: TOKEN },
    });
    await client.connect(transport);
    mcpClient = client as unknown as typeof mcpClient;

    // Wait for the extension to authenticate against the now-running server.
    await waitForAuthed(sw);
  }, 30_000);

  afterAll(async () => {
    await mcpClient?.close().catch(() => {});
    await ctx?.close().catch(() => {});
  });

  it("tabs_list returns the live Chromium tabs", async () => {
    const page = await ctx.newPage();
    await page.goto("https://example.com/");

    const result = await mcpClient.callTool({ name: "tabs_list", arguments: {} });
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.some((t: { url: string }) => t.url.startsWith("https://example.com"))).toBe(true);
  }, 20_000);

  it("page_navigate auto-claims the tab: overlay shadow-DOM appears", async () => {
    const page = await ctx.newPage();
    await page.goto("about:blank");

    // Ask the SW for the new tab's id.
    const tabId = await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return tabs[0]!.id!;
    });

    await mcpClient.callTool({
      name: "page_navigate",
      arguments: { tabId, url: "https://example.com/" },
    });
    await page.waitForURL(/example\.com/, { timeout: 10_000 });

    const hasOverlay = await page.evaluate(
      () => !!document.querySelector('div[data-browseruse="overlay"]')
    );
    expect(hasOverlay).toBe(true);
  }, 30_000);
});
