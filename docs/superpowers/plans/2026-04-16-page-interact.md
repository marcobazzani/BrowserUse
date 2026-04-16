# Page Interact: click, type + trivial adapters

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development

**Goal:** Add `page.click` and `page.type`, plus MCP tool adapters for three wire methods whose extension handlers already exist but are unexposed: `tabs.close`, `tabs.activate`, `session.release`. After this plan the agent can fill forms, submit them, and tidy up after itself.

**Prerequisite:** the page-read plan should land first — `page.snapshot` (a11y mode) gives Claude the selectors it'll pass to click/type. Without it, Claude has to guess selectors.

**Architecture:** click / type run in-page via `chrome.scripting.executeScript({ func })`, mirroring the snapshot pattern. Adapters for the three pre-existing wire methods are cookie-cutter.

---

### Task 1: Wire protocol (shared)

**Files:**
- Modify: `packages/shared/src/protocol.ts`
- Modify: `packages/shared/test/protocol.test.ts`

- [ ] **Add click/type schemas, register in METHODS**

```ts
export const PageClickParamsSchema = z
  .object({
    tabId: z.number().int(),
    selector: z.string().min(1),
    button: z.enum(["left", "right", "middle"]).default("left"),
    scrollIntoView: z.boolean().default(true),
  })
  .strict();
export const PageClickResultSchema = z.object({ ok: z.literal(true) }).strict();

export const PageTypeParamsSchema = z
  .object({
    tabId: z.number().int(),
    selector: z.string().min(1),
    text: z.string(),
    submit: z.boolean().default(false),
    clear: z.boolean().default(true),
  })
  .strict();
export const PageTypeResultSchema = z.object({ ok: z.literal(true) }).strict();
```

Add both to `METHODS`:
```ts
"page.click": { params: PageClickParamsSchema, result: PageClickResultSchema },
"page.type":  { params: PageTypeParamsSchema,  result: PageTypeResultSchema },
```

- [ ] **Round-trip tests**
```ts
it("page.click rejects empty selector", () => {
  expect(() => PageClickParamsSchema.parse({ tabId: 1, selector: "" })).toThrow();
});
it("page.type defaults submit=false, clear=true", () => {
  const p = PageTypeParamsSchema.parse({ tabId: 1, selector: "#q", text: "hi" });
  expect(p.submit).toBe(false);
  expect(p.clear).toBe(true);
});
```

- [ ] Build + commit: `feat(shared): wire schemas for page.click + page.type`

---

### Task 2: MCP tool adapters — five new tools

**Files:**
- Modify: `packages/mcp-server/src/tools.ts`
- Modify: `packages/mcp-server/test/tools.unit.test.ts`

- [ ] **Import the schemas** (add to existing import of `@browseruse/shared`):
```ts
import {
  // existing
  TabsCloseParamsSchema,
  TabsActivateParamsSchema,
  SessionReleaseParamsSchema,
  PageClickParamsSchema,
  PageTypeParamsSchema,
} from "@browseruse/shared";
```

- [ ] **Inside `buildTools`, add five adapters**. The new tools `page_click` and `page_type` auto-claim; the housekeeping ones (`tabs_close`, `tabs_activate`, `session_release`) deliberately do NOT auto-claim — closing a tab you just claimed is pointless, activating / releasing shouldn't re-mark.

```ts
const tabs_close: Tool<z.infer<typeof TabsCloseParamsSchema>> = {
  description: "Close the given tab.",
  inputSchema: TabsCloseParamsSchema,
  handler: async (params) => {
    guard(bridge);
    return text(await bridge.call("tabs.close", TabsCloseParamsSchema.parse(params)));
  },
};

const tabs_activate: Tool<z.infer<typeof TabsActivateParamsSchema>> = {
  description: "Bring a tab to the foreground in its window.",
  inputSchema: TabsActivateParamsSchema,
  handler: async (params) => {
    guard(bridge);
    return text(await bridge.call("tabs.activate", TabsActivateParamsSchema.parse(params)));
  },
};

const session_release: Tool<z.infer<typeof SessionReleaseParamsSchema>> = {
  description: "Release a tab from the Claude tab group and remove its overlay. Call when done with a tab.",
  inputSchema: SessionReleaseParamsSchema,
  handler: async (params) => {
    guard(bridge);
    return text(await bridge.call("session.release", SessionReleaseParamsSchema.parse(params)));
  },
};

const page_click: Tool<z.infer<typeof PageClickParamsSchema>> = {
  description: "Click an element in a tab by CSS selector.",
  inputSchema: PageClickParamsSchema,
  handler: async (params) => {
    guard(bridge);
    const parsed = PageClickParamsSchema.parse(params);
    await ensureClaim(parsed.tabId);
    return text(await bridge.call("page.click", parsed));
  },
};

const page_type: Tool<z.infer<typeof PageTypeParamsSchema>> = {
  description: "Type text into an input/textarea by CSS selector. Optionally submits the form.",
  inputSchema: PageTypeParamsSchema,
  handler: async (params) => {
    guard(bridge);
    const parsed = PageTypeParamsSchema.parse(params);
    await ensureClaim(parsed.tabId);
    return text(await bridge.call("page.type", parsed));
  },
};

return {
  tabs_list, tabs_create, tabs_close, tabs_activate,
  page_navigate, page_click, page_type,
  session_release,
  // … page_snapshot, page_screenshot from the page-read plan if landed first
};
```

- [ ] **Unit tests** — extend the fake bridge to answer these methods and add one test per adapter. Emphasis on:
  - `page_click` auto-claims (ordering `[session.claim, page.click]`).
  - `page_type` auto-claims.
  - `tabs_close` does NOT call `session.claim`.
  - `session_release` does NOT call `session.claim`.

- [ ] Build + commit: `feat(mcp-server): expose tabs_close/tabs_activate/page_click/page_type/session_release tools`

---

### Task 3: Extension handlers for click + type

**Files:**
- Create: `packages/extension/src/handlers/page-interact.ts`
- Modify: `packages/extension/src/handlers/index.ts`
- Modify: `packages/extension/test/handlers.unit.test.ts`

- [ ] **Handler module**

```ts
import type { Dispatcher } from "../dispatcher.js";
import { PageClickParamsSchema, PageTypeParamsSchema } from "@browseruse/shared";

function inPageClick(selector: string, button: "left" | "right" | "middle", scroll: boolean) {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) throw new Error(`selector did not match: ${selector}`);
  if (scroll) el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
  const btn = button === "right" ? 2 : button === "middle" ? 1 : 0;
  const opts = { bubbles: true, cancelable: true, view: window, button: btn } as MouseEventInit;
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.dispatchEvent(new MouseEvent("click", opts));
  return { ok: true as const };
}

function inPageType(selector: string, text: string, submit: boolean, clear: boolean) {
  const el = document.querySelector(selector) as
    | HTMLInputElement
    | HTMLTextAreaElement
    | (HTMLElement & { isContentEditable: boolean })
    | null;
  if (!el) throw new Error(`selector did not match: ${selector}`);
  el.focus();
  if ("value" in el) {
    if (clear) el.value = "";
    // Set value via property descriptor so React et al. see the change.
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    (setter ? setter.call(el, (el.value ?? "") + text) : (el.value = (el.value ?? "") + text));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    if (submit && "form" in el && (el as HTMLInputElement).form) {
      (el as HTMLInputElement).form!.requestSubmit();
    }
  } else if ((el as any).isContentEditable) {
    if (clear) el.textContent = "";
    el.textContent = (el.textContent ?? "") + text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  } else {
    throw new Error(`selector matched a non-input element: ${selector}`);
  }
  return { ok: true as const };
}

export function registerPageInteractHandlers(d: Dispatcher) {
  d.register("page.click", async (raw) => {
    const p = PageClickParamsSchema.parse(raw);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      func: inPageClick,
      args: [p.selector, p.button, p.scrollIntoView],
    });
    return result;
  });

  d.register("page.type", async (raw) => {
    const p = PageTypeParamsSchema.parse(raw);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      func: inPageType,
      args: [p.selector, p.text, p.submit, p.clear],
    });
    return result;
  });
}
```

- [ ] **Register + test**. Unit tests verify `executeScript` is called with the expected `func`, `args`, and that the handler returns `{ ok: true }`. Integration test (existing real-bridge fake-extension pattern) — responder mock returns `{ ok: true }` and verifies the wire method + params.

- [ ] Build + commit: `feat(extension): page.click + page.type handlers`

---

### Task 4: Manual verification

- [ ] Reload extension.
- [ ] *"Open https://duckduckgo.com, type 'model context protocol' into the search box and submit."* — verifies `page_navigate` → `page_snapshot` (a11y, from the previous plan) → `page_type` (with submit:true).
- [ ] *"Click the first result."* — verifies `page_click`.
- [ ] *"Close the tab."* — verifies `tabs_close`.
- [ ] Observe: when you close the tab, the "Claude" tab group shrinks / disappears if empty (it was already empty after close; deletion is automatic).

## Out of scope

- Keyboard shortcuts / key-by-key typing (we set value + dispatch input/change). Good enough for 95% of forms. Contact forms using complex JS frameworks (Cypress-level realism) may need per-keystroke. Follow-up plan.
- Hover / right-click menus.
- Multi-element click (click the 3rd matching element) — selector must be unique for now.
- XPath / text selectors. CSS only. (If CLAUDE asks for an `::-webkit-scrollbar-thumb` click, that's a you-problem.)
