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

const SHOULD_RUN = process.env.CHROMANCHE_E2E === "1";
const describeE2E = SHOULD_RUN ? describe : describe.skip;

const PORT = "59335";
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
 * End-to-end check that page_type produces REAL keydown events (not just
 * Input.insertText). Real keystrokes are required for apps with custom
 * input pipelines (Office365 / Excel for the Web, Google Sheets, Figma).
 */
describeE2E("page_type: real keystrokes reach the page (not Input.insertText)", () => {
  let ctx: BrowserContext;
  let sw: Worker;
  let mcpClient: {
    callTool: (req: { name: string; arguments: unknown }) => Promise<{ content: Array<{ text: string }> }>;
    close: () => Promise<void>;
  };
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    if (!existsSync(extDir)) throw new Error(`extension not built: ${extDir}`);
    if (!existsSync(serverEntry)) throw new Error(`server not built: ${serverEntry}`);

    // Test page: a textarea whose keydown handler logs each event into
    // window.__keys. Intentionally does NOT listen for the 'input' or
    // 'beforeinput' event — Input.insertText would fire those but NOT
    // keydown, so a passing test rules out the insertText path.
    const html = `<!doctype html><html><body>
      <h1>Keystroke check</h1>
      <textarea id="t" rows="3" cols="40"></textarea>
      <script>
        // Record at document level so Tab moving focus off the textarea
        // doesn't drop subsequent keys from the log. We need to see Enter
        // and the post-Tab keys, not just whatever the textarea catches.
        window.__keys = [];
        document.addEventListener('keydown', (e) => {
          window.__keys.push({ key: e.key, code: e.code, keyCode: e.keyCode });
        }, true);
      </script>
    </body></html>`;

    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    origin = `http://127.0.0.1:${port}`;

    ctx = await chromium.launchPersistentContext("", {
      headless: false,
      args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
    });
    sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
    await setExtensionStorage(sw, { token: TOKEN, port: Number(PORT) });

    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    const transport = new StdioClientTransport({
      command: "node",
      args: [serverEntry],
      env: { ...process.env, CHROMANCHE_PORT: PORT, CHROMANCHE_TOKEN: TOKEN },
    });
    await client.connect(transport);
    mcpClient = client as unknown as typeof mcpClient;
    await waitForAuthed(sw);
  }, 30_000);

  afterAll(async () => {
    await mcpClient?.close().catch(() => {});
    await ctx?.close().catch(() => {});
    await new Promise<void>((r) => server?.close(() => r()));
  });

  it("expands embedded \\t to Tab and \\n to Enter so one call enters a whole grid row", async () => {
    const page = await ctx.newPage();
    await page.goto(`${origin}/`);
    await page.locator("#t").waitFor({ state: "attached", timeout: 5_000 });

    const tabId = await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return tabs[0]!.id!;
    });

    const snap = await mcpClient.callTool({
      name: "page_snapshot",
      arguments: { tabId, mode: "a11y" },
    });
    const parsed = JSON.parse(snap.content[0]!.text as string) as { content: string };
    const m = parsed.content.match(/\[(e\d+)\][^\n]*textbox/);
    expect(m, `textarea uid not found in:\n${parsed.content}`).toBeTruthy();
    const uid = m![1]!;

    await mcpClient.callTool({
      name: "page_type",
      arguments: { tabId, uid, text: "a\tb\nc" },
    });

    const keys = await page.evaluate(() =>
      (window as unknown as { __keys: Array<{ key: string }> }).__keys.map((k) => k.key),
    );
    expect(keys).toEqual(["a", "Tab", "b", "Enter", "c"]);
  }, 30_000);

  it("dispatches a keydown event per character of the input text", async () => {
    const page = await ctx.newPage();
    await page.goto(`${origin}/`);
    await page.locator("#t").waitFor({ state: "attached", timeout: 5_000 });

    const tabId = await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return tabs[0]!.id!;
    });

    // Find the textarea uid via snapshot.
    const snap = await mcpClient.callTool({
      name: "page_snapshot",
      arguments: { tabId, mode: "a11y" },
    });
    const parsed = JSON.parse(snap.content[0]!.text as string) as { content: string };
    const m = parsed.content.match(/\[(e\d+)\][^\n]*textbox/);
    expect(m, `textarea uid not found in:\n${parsed.content}`).toBeTruthy();
    const uid = m![1]!;

    await mcpClient.callTool({
      name: "page_type",
      arguments: { tabId, uid, text: "ab12@" },
    });

    // Real keydowns must have reached the page. If page_type used
    // Input.insertText, __keys would be empty.
    const keys = await page.evaluate(() => (window as unknown as { __keys: Array<{ key: string }> }).__keys);
    const typed = keys.map((k) => k.key).join("");
    expect(typed).toBe("ab12@");
  }, 30_000);
});
