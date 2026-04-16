# GIF record

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development

**Goal:** Ship `gif.record` — a tool that accepts a sequence of browser steps (navigate/click/type), executes them, captures a frame between each, compiles an animated GIF, saves it under `~/Downloads/` (or a configured path), and returns the file path.

**Prerequisite:** the page-interact plan must be in place — `gif.record` reuses `page.navigate` / `page.click` / `page.type` + `page.screenshot`. Without them the step execution doesn't work.

**Architecture:**
- Tool lives on the MCP server side. The MCP server orchestrates: it calls existing wire methods via the BridgeServer (not via other MCP tools — no layering through MCP itself) to execute each step, capture frames, and assemble the GIF.
- GIF encoding happens server-side (Node.js). Use `gifenc` — tiny (~8 KB), zero deps, browser-and-node-compatible, MIT licensed.
- No new extension-side wire method is strictly required; but a `gif.capture` helper that returns multiple frames in one call would be nice to reduce round trips. For v0.2 we stick with the one-screenshot-per-step approach, even though it's chattier.

---

### Task 1: Wire protocol (shared)

`gif.record` does NOT become a wire method — the orchestration is server-local and uses existing wire methods. Skip shared changes. Commit nothing in the shared package.

---

### Task 2: MCP server — the tool

**Files:**
- Create: `packages/mcp-server/src/gif.ts`
- Modify: `packages/mcp-server/src/tools.ts` (register `gif_record`)
- Modify: `packages/mcp-server/package.json` (add `gifenc`)
- Create: `packages/mcp-server/test/gif.unit.test.ts`

- [ ] **Add `gifenc` dep**

```json
"dependencies": {
  ...,
  "gifenc": "1.0.3"
}
```

- [ ] **`src/gif.ts`**

```ts
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GIFEncoder, quantize, applyPalette } from "gifenc";
import { z } from "zod";
import type { BridgeServer } from "./bridge.js";

const StepSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), tabId: z.number().int(), url: z.string().url() }).strict(),
  z.object({ type: z.literal("click"),    tabId: z.number().int(), selector: z.string().min(1) }).strict(),
  z.object({ type: z.literal("type"),     tabId: z.number().int(), selector: z.string().min(1), text: z.string(), submit: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal("sleep"),    ms: z.number().int().positive().max(30_000) }).strict(),
]);
export const GifRecordParamsSchema = z.object({
  steps: z.array(StepSchema).min(1).max(50),
  filename: z.string().regex(/^[a-zA-Z0-9._-]+\.gif$/).default("browseruse.gif"),
  captureTabId: z.number().int(),
  frameDelayMs: z.number().int().positive().max(10_000).default(800),
  maxWidth: z.number().int().positive().max(2048).default(800),
}).strict();

export const GifRecordResultSchema = z.object({
  path: z.string(),
  frames: z.number().int(),
  bytes: z.number().int(),
}).strict();

export type GifRecordParams = z.infer<typeof GifRecordParamsSchema>;
export type GifRecordResult = z.infer<typeof GifRecordResultSchema>;

/** Decode a base64 PNG → RGBA Uint8ClampedArray. Pure Node, no canvas. */
async function pngBase64ToRgba(base64: string): Promise<{ width: number; height: number; pixels: Uint8ClampedArray }> {
  // pngjs is ~20 KB and synchronous — acceptable. Alternative: sharp (larger).
  const { PNG } = await import("pngjs");
  const buf = Buffer.from(base64, "base64");
  const img = PNG.sync.read(buf);
  return { width: img.width, height: img.height, pixels: new Uint8ClampedArray(img.data) };
}

function downscaleRgba(src: { width: number; height: number; pixels: Uint8ClampedArray }, maxW: number) {
  if (src.width <= maxW) return src;
  const scale = maxW / src.width;
  const dstW = maxW;
  const dstH = Math.round(src.height * scale);
  const dst = new Uint8ClampedArray(dstW * dstH * 4);
  // Nearest-neighbour — good enough for GIF, keeps deps at zero.
  for (let y = 0; y < dstH; y++) {
    const sy = Math.floor(y / scale);
    for (let x = 0; x < dstW; x++) {
      const sx = Math.floor(x / scale);
      const si = (sy * src.width + sx) * 4;
      const di = (y * dstW + x) * 4;
      dst[di]     = src.pixels[si]!;
      dst[di + 1] = src.pixels[si + 1]!;
      dst[di + 2] = src.pixels[si + 2]!;
      dst[di + 3] = src.pixels[si + 3]!;
    }
  }
  return { width: dstW, height: dstH, pixels: dst };
}

export async function runGifRecord(bridge: BridgeServer, params: GifRecordParams): Promise<GifRecordResult> {
  const frames: { width: number; height: number; pixels: Uint8ClampedArray }[] = [];

  const capture = async () => {
    const shot = (await bridge.call("page.screenshot", { tabId: params.captureTabId, format: "png" })) as { base64: string };
    const rgba = await pngBase64ToRgba(shot.base64);
    frames.push(downscaleRgba(rgba, params.maxWidth));
  };

  await capture(); // initial frame
  for (const step of params.steps) {
    switch (step.type) {
      case "navigate":
        await bridge.call("page.navigate", { tabId: step.tabId, url: step.url });
        break;
      case "click":
        await bridge.call("page.click", { tabId: step.tabId, selector: step.selector });
        break;
      case "type":
        await bridge.call("page.type", { tabId: step.tabId, selector: step.selector, text: step.text, submit: step.submit });
        break;
      case "sleep":
        await new Promise((r) => setTimeout(r, step.ms));
        break;
    }
    await capture();
  }

  // Encode
  const enc = GIFEncoder();
  const ref = frames[0]!;
  for (const f of frames) {
    const palette = quantize(f.pixels, 256);
    const indexed = applyPalette(f.pixels, palette);
    enc.writeFrame(indexed, f.width, f.height, { palette, delay: params.frameDelayMs });
  }
  enc.finish();
  const bytes = enc.bytesView();

  const dir = join(homedir(), "Downloads");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, params.filename);
  writeFileSync(out, bytes);
  return { path: out, frames: frames.length, bytes: bytes.byteLength };
}
```

- [ ] **Register the tool in `tools.ts`**

```ts
import { GifRecordParamsSchema, runGifRecord } from "./gif.js";

const gif_record: Tool<z.infer<typeof GifRecordParamsSchema>> = {
  description: "Execute a step sequence (navigate/click/type/sleep) and save an animated GIF of the run to ~/Downloads.",
  inputSchema: GifRecordParamsSchema,
  handler: async (params) => {
    guard(bridge);
    const parsed = GifRecordParamsSchema.parse(params);
    await ensureClaim(parsed.captureTabId);
    return text(await runGifRecord(bridge, parsed));
  },
};
```

- [ ] **Unit tests** — mock `bridge.call` with a fake screenshot (tiny 2×2 PNG as base64) and assert: frames count = steps + 1, output file exists and starts with GIF89a magic, declared size matches `fs.statSync`.

- [ ] **Add `pngjs`** as a dep. It's ~50 KB pure-JS PNG decoder, no native bits. Version: `7.0.0`.

- [ ] Build + commit: `feat(mcp-server): gif_record tool — step sequence → animated GIF in ~/Downloads`

---

### Task 3: Manual verification

- [ ] *"Record a gif: open https://example.com, then click the 'More information...' link, name the file demo.gif."* — Claude should call `gif_record` with two steps. Watch Chrome: two screenshots captured. Open `~/Downloads/demo.gif` — two frames, 800ms apart.
- [ ] Try with a real form flow (DuckDuckGo search) — expect a ~5-frame GIF showing the navigation, typing, submission.

## Out of scope

- Per-step custom delay (single `frameDelayMs` for now). Step-level override is easy — add `{ step: ..., delayMs?: number }` later.
- Video output (MP4). GIF is universally renderable in LLM chat UIs; MP4 requires a ffmpeg dep, which expands the install footprint.
- High-framerate capture between steps (e.g. 10 fps instead of one shot per step). Hitting the WS that hard would stress the extension; if needed later, collapse screenshots into a batched wire method.
- Upload to a file-sharing service. Keep output local by design.
