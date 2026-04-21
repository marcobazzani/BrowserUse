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

const PORT = "59333"; // distinct from other e2e tests
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

/**
 * Spin up an http server on 127.0.0.1:random serving a single HTML body.
 * Returns the origin string (e.g. "http://127.0.0.1:54321").
 */
async function serveOrigin(html: string): Promise<{ origin: string; server: Server }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${addr.port}`, server };
}

describeE2E("OOPIF: content inside a cross-origin iframe is visible and interactive", () => {
  let ctx: BrowserContext;
  let sw: Worker;
  let mcpClient: {
    callTool: (req: { name: string; arguments: unknown }) => Promise<{ content: Array<{ text: string }> }>;
    close: () => Promise<void>;
  };
  let outerOrigin: string;
  let innerOrigin: string;
  let outerServer: Server;
  let innerServer: Server;

  beforeAll(async () => {
    if (!existsSync(extDir)) throw new Error(`extension not built: ${extDir}`);
    if (!existsSync(serverEntry)) throw new Error(`server not built: ${serverEntry}`);

    // Inner page: a button that records clicks on window.__clicks.
    const innerHtml = `<!doctype html><html><body>
      <button id="inner-btn">Inner iframe button</button>
      <script>
        window.__clicks = 0;
        document.getElementById('inner-btn').addEventListener('click', () => { window.__clicks++; });
      </script>
    </body></html>`;

    const inner = await serveOrigin(innerHtml);
    const innerPort = (inner.server.address() as AddressInfo).port;
    innerServer = inner.server;

    // Outer page references the inner frame by a VIRTUAL hostname that we'll
    // alias to 127.0.0.1 via Chromium's --host-resolver-rules. Two distinct
    // registrable domains → two distinct sites → a real OOPIF is created,
    // which is the only interesting shape for this test. (Same-host-different-
    // port, even with --isolate-origins, does not reliably give us an OOPIF
    // in Chromium.)
    const innerHost = "inner.test";
    const outerHost = "outer.test";
    innerOrigin = `http://${innerHost}:${innerPort}`;
    const outerHtml = `<!doctype html><html><body>
      <h1>Outer page</h1>
      <iframe id="f" src="${innerOrigin}/" style="width:400px;height:200px;border:1px solid #ccc"></iframe>
    </body></html>`;

    const outer = await serveOrigin(outerHtml);
    const outerPort = (outer.server.address() as AddressInfo).port;
    outerOrigin = `http://${outerHost}:${outerPort}`;
    outerServer = outer.server;

    ctx = await chromium.launchPersistentContext("", {
      headless: false,
      args: [
        `--disable-extensions-except=${extDir}`,
        `--load-extension=${extDir}`,
        `--host-resolver-rules=MAP ${outerHost} 127.0.0.1, MAP ${innerHost} 127.0.0.1`,
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
    await new Promise<void>((r) => innerServer?.close(() => r()));
  });

  it("a11y snapshot includes iframe-internal interactive elements with a resolvable uid", async () => {
    const page = await ctx.newPage();
    await page.goto(`${outerOrigin}/`);

    // Wait for the iframe to actually load so its frame target exists before we snapshot.
    const frame = page.frameLocator("#f");
    await frame.locator("#inner-btn").waitFor({ state: "attached", timeout: 10_000 });

    // Ask the SW for this tab's id.
    const tabId = await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return tabs[0]!.id!;
    });

    // Poll for the OOPIF subtree to appear. Target.attachedToTarget arrives
    // via IPC asynchronously after the iframe DOM is ready, so the first
    // snapshot may not yet include it on slower CI runners.
    let parsed: { content: string } = { content: "" };
    for (let attempt = 0; attempt < 10; attempt++) {
      const snap = await mcpClient.callTool({
        name: "page_snapshot",
        arguments: { tabId, mode: "a11y" },
      });
      parsed = JSON.parse(snap.content[0]!.text as string) as { content: string };
      if (/Inner iframe button/.test(parsed.content)) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    // The inner button lives inside a cross-origin iframe; it should appear
    // in the merged tree thanks to OOPIF support.
    expect(parsed.content, parsed.content).toMatch(/Inner iframe button/);

    // Extract the uid assigned to the inner button.
    const match = parsed.content.match(/\[(e\d+)\][^\n]*Inner iframe button/);
    expect(match, `inner button uid not found in snapshot:\n${parsed.content}`).toBeTruthy();
    const uid = match![1]!;

    // Click via the uid — should dispatch into the iframe's session.
    await mcpClient.callTool({
      name: "page_click",
      arguments: { tabId, uid },
    });

    // Verify the click landed inside the iframe by reading __clicks.
    const clicks = await frame.locator("#inner-btn").evaluate((_, _none) => (window as unknown as { __clicks: number }).__clicks);
    expect(clicks).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
