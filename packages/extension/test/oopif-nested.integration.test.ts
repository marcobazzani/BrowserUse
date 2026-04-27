import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type BrowserContext, type Worker } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const here = dirname(fileURLToPath(import.meta.url));
const extDir = resolve(here, "../dist");
const serverEntry = resolve(here, "../../mcp-server/dist/index.cjs");

const SHOULD_RUN = process.env.BROWSERUSE_E2E === "1";
const describeE2E = SHOULD_RUN ? describe : describe.skip;

const PORT = "59334"; // distinct from other e2e tests
const TOKEN = randomBytes(24).toString("hex");

async function setExtensionStorage(sw: Worker, data: Record<string, unknown>) {
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
    const status = await sw
      .evaluate(async () => {
        const r = await chrome.storage.local.get("status");
        return r.status as string | undefined;
      })
      .catch(() => undefined);
    if (status === "authed") return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("extension did not reach status=authed in time");
}

async function serveOrigin(html: string): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, port: addr.port };
}

/**
 * Three-site nested OOPIF: outer.test → middle.test → inner.test.
 * Each iframe boundary is a real cross-site → real OOPIF target. Models the
 * Office365 / SharePoint shape (shell → app frame → addin frame) where
 * Target.attachedToTarget for the innermost iframe arrives on the MIDDLE
 * frame's session — not the tab session — so the SW must resolve targetId
 * sources back to the owning tab AND must have called Target.setAutoAttach
 * on the middle frame's session.
 */
describeE2E("OOPIF nesting: snapshot reaches a button in a doubly-nested cross-origin iframe", () => {
  let ctx: BrowserContext;
  let sw: Worker;
  let mcpClient: {
    callTool: (req: { name: string; arguments: unknown }) => Promise<{ content: Array<{ text: string }> }>;
    close: () => Promise<void>;
  };
  let outerOrigin: string;
  let outerServer: Server;
  let middleServer: Server;
  let innerServer: Server;

  beforeAll(async () => {
    if (!existsSync(extDir)) throw new Error(`extension not built: ${extDir}`);
    if (!existsSync(serverEntry)) throw new Error(`server not built: ${serverEntry}`);

    const innerHtml = `<!doctype html><html><body>
      <button id="deep-btn">Deeply nested button</button>
      <script>
        window.__deepClicks = 0;
        document.getElementById('deep-btn').addEventListener('click', () => { window.__deepClicks++; });
      </script>
    </body></html>`;

    const inner = await serveOrigin(innerHtml);
    innerServer = inner.server;
    const innerOrigin = `http://inner.test:${inner.port}`;

    const middleHtml = `<!doctype html><html><body>
      <h2>Middle frame</h2>
      <iframe id="g" src="${innerOrigin}/" style="width:380px;height:160px;border:1px solid #888"></iframe>
    </body></html>`;

    const middle = await serveOrigin(middleHtml);
    middleServer = middle.server;
    const middleOrigin = `http://middle.test:${middle.port}`;

    const outerHtml = `<!doctype html><html><body>
      <h1>Outer page</h1>
      <iframe id="f" src="${middleOrigin}/" style="width:420px;height:240px;border:1px solid #ccc"></iframe>
    </body></html>`;

    const outer = await serveOrigin(outerHtml);
    outerServer = outer.server;
    outerOrigin = `http://outer.test:${outer.port}`;

    ctx = await chromium.launchPersistentContext("", {
      headless: false,
      args: [
        `--disable-extensions-except=${extDir}`,
        `--load-extension=${extDir}`,
        `--host-resolver-rules=MAP outer.test 127.0.0.1, MAP middle.test 127.0.0.1, MAP inner.test 127.0.0.1`,
        `--site-per-process`,
      ],
    });

    sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));

    await setExtensionStorage(sw, { token: TOKEN, port: Number(PORT) });

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

    await waitForAuthed(sw);
  }, 30_000);

  afterAll(async () => {
    await mcpClient?.close().catch(() => {});
    await ctx?.close().catch(() => {});
    await new Promise<void>((r) => outerServer?.close(() => r()));
    await new Promise<void>((r) => middleServer?.close(() => r()));
    await new Promise<void>((r) => innerServer?.close(() => r()));
  });

  it("snapshot includes the innermost button and click via uid lands in the deepest frame", async () => {
    const page = await ctx.newPage();
    await page.goto(`${outerOrigin}/`);

    // Drill down through both frame layers and wait for the deepest button.
    const middleFrame = page.frameLocator("#f");
    const innerFrame = middleFrame.frameLocator("#g");
    await innerFrame.locator("#deep-btn").waitFor({ state: "attached", timeout: 10_000 });

    const tabId = await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return tabs[0]!.id!;
    });

    // Poll the snapshot — Target.attachedToTarget for the deepest OOPIF
    // arrives via IPC after the renderer has the iframe attached.
    let parsed: { content: string } = { content: "" };
    for (let attempt = 0; attempt < 15; attempt++) {
      const snap = await mcpClient.callTool({
        name: "page_snapshot",
        arguments: { tabId, mode: "a11y" },
      });
      parsed = JSON.parse(snap.content[0]!.text as string) as { content: string };
      if (/Deeply nested button/.test(parsed.content)) break;
      await new Promise((r) => setTimeout(r, 300));
    }

    expect(parsed.content, parsed.content).toMatch(/Deeply nested button/);

    const match = parsed.content.match(/\[(e\d+)\][^\n]*Deeply nested button/);
    expect(match, `deep button uid not found in snapshot:\n${parsed.content}`).toBeTruthy();
    const uid = match![1]!;

    await mcpClient.callTool({
      name: "page_click",
      arguments: { tabId, uid },
    });

    const clicks = await innerFrame.locator("#deep-btn").evaluate(() =>
      (window as unknown as { __deepClicks: number }).__deepClicks,
    );
    expect(clicks).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
