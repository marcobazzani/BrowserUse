import type { Dispatcher } from "../dispatcher.js";
import type { DebuggerManager } from "../lib/debugger-manager.js";
import {
  PageClickParamsSchema,
  PageTypeParamsSchema,
  PageScrollParamsSchema,
  PageHoverParamsSchema,
  PagePressKeyParamsSchema,
  PageFillFormParamsSchema,
} from "@browseruse/shared";
import { resolveUid } from "../lib/snapshot-manager.js";
import { takeA11ySnapshot } from "./page-read.js";

/* ---------- helpers ---------- */

/** Resolve a uid to a CDP objectId for the target tab. */
async function resolveElement(
  mgr: DebuggerManager,
  tabId: number,
  uid?: string,
  selector?: string,
): Promise<{ objectId: string }> {
  if (uid) {
    const entry = resolveUid(tabId, uid);
    if (!entry) throw new Error(`uid "${uid}" not found — take a new snapshot first`);
    const r = await mgr.sendCommand<{ object: { objectId?: string } }>(
      tabId,
      "DOM.resolveNode",
      { backendNodeId: entry.backendNodeId },
    );
    if (!r.object?.objectId) throw new Error(`uid "${uid}" could not be resolved to a DOM node`);
    return { objectId: r.object.objectId };
  }
  if (selector) {
    // Get document root, then querySelector.
    const doc = await mgr.sendCommand<{ root: { nodeId: number } }>(tabId, "DOM.getDocument", {});
    const q = await mgr.sendCommand<{ nodeId: number }>(
      tabId,
      "DOM.querySelector",
      { nodeId: doc.root.nodeId, selector },
    );
    if (!q.nodeId) throw new Error(`selector did not match: ${selector}`);
    const r = await mgr.sendCommand<{ object: { objectId?: string } }>(
      tabId,
      "DOM.resolveNode",
      { nodeId: q.nodeId },
    );
    if (!r.object?.objectId) throw new Error(`selector resolved but node has no JS object`);
    return { objectId: r.object.objectId };
  }
  throw new Error("provide either uid or selector");
}

/** Get the center coordinates of an element for CDP mouse events. */
async function getElementCenter(
  mgr: DebuggerManager,
  tabId: number,
  objectId: string,
): Promise<{ x: number; y: number }> {
  // scrollIntoViewIfNeeded first.
  await mgr.sendCommand(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() { this.scrollIntoViewIfNeeded(true); }`,
    returnByValue: true,
  });
  const box = await mgr.sendCommand<{ model: { content: number[] } }>(
    tabId,
    "DOM.getBoxModel",
    { objectId },
  );
  // content quad: [x1,y1, x2,y2, x3,y3, x4,y4]
  const q = box.model.content;
  const x = (q[0] + q[2] + q[4] + q[6]) / 4;
  const y = (q[1] + q[3] + q[5] + q[7]) / 4;
  return { x, y };
}

async function maybeSnapshot(
  mgr: DebuggerManager,
  tabId: number,
  include: boolean,
): Promise<string | undefined> {
  if (!include) return undefined;
  // Small delay to let the page react (e.g. form validation, dropdown open).
  await new Promise((r) => setTimeout(r, 150));
  return takeA11ySnapshot(mgr, tabId);
}

// In-page scroll function (self-contained, no closures).
function inPageScroll(
  dx: number | undefined,
  dy: number | undefined,
  selector: string | undefined,
  to: "top" | "bottom" | undefined,
  smooth: boolean,
) {
  const behavior: ScrollBehavior = smooth ? "smooth" : ("instant" as ScrollBehavior);
  if (selector !== undefined) {
    const el = document.querySelector(selector) as HTMLElement | null;
    if (!el) throw new Error(`selector did not match: ${selector}`);
    el.scrollIntoView({ behavior, block: "center", inline: "center" });
  } else if (to === "top") {
    window.scrollTo({ top: 0, left: 0, behavior });
  } else if (to === "bottom") {
    window.scrollTo({ top: document.documentElement.scrollHeight, left: 0, behavior });
  } else {
    window.scrollBy({ left: dx ?? 0, top: dy ?? 0, behavior });
  }
  return { ok: true as const };
}

/* ---------- KEY MAP for CDP Input.dispatchKeyEvent ---------- */

const KEY_DEFS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter:      { key: "Enter",     code: "Enter",       keyCode: 13, text: "\r" },
  Tab:        { key: "Tab",       code: "Tab",         keyCode: 9 },
  Escape:     { key: "Escape",    code: "Escape",      keyCode: 27 },
  Backspace:  { key: "Backspace", code: "Backspace",   keyCode: 8 },
  Delete:     { key: "Delete",    code: "Delete",      keyCode: 46 },
  ArrowUp:    { key: "ArrowUp",   code: "ArrowUp",     keyCode: 38 },
  ArrowDown:  { key: "ArrowDown", code: "ArrowDown",   keyCode: 40 },
  ArrowLeft:  { key: "ArrowLeft", code: "ArrowLeft",    keyCode: 37 },
  ArrowRight: { key: "ArrowRight",code: "ArrowRight",   keyCode: 39 },
  Home:       { key: "Home",      code: "Home",        keyCode: 36 },
  End:        { key: "End",       code: "End",         keyCode: 35 },
  PageUp:     { key: "PageUp",    code: "PageUp",      keyCode: 33 },
  PageDown:   { key: "PageDown",  code: "PageDown",    keyCode: 34 },
  Space:      { key: " ",         code: "Space",       keyCode: 32, text: " " },
};

function resolveKey(key: string) {
  if (KEY_DEFS[key]) return KEY_DEFS[key];
  // Single character.
  if (key.length === 1) {
    const code = `Key${key.toUpperCase()}`;
    return { key, code, keyCode: key.toUpperCase().charCodeAt(0), text: key };
  }
  // Pass through unknown keys as-is.
  return { key, code: key, keyCode: 0 };
}

function modifierFlags(mods: string[]): number {
  let flags = 0;
  for (const m of mods) {
    if (m === "Alt") flags |= 1;
    if (m === "Control") flags |= 2;
    if (m === "Meta") flags |= 4;
    if (m === "Shift") flags |= 8;
  }
  return flags;
}

/* ---------- handlers ---------- */

export function registerPageInteractHandlers(d: Dispatcher, mgr: DebuggerManager) {
  d.register("page.click", async (raw) => {
    const p = PageClickParamsSchema.parse(raw);
    const el = await resolveElement(mgr, p.tabId, p.uid, p.selector);
    const { x, y } = await getElementCenter(mgr, p.tabId, el.objectId);
    const btn = p.button === "right" ? 2 : p.button === "middle" ? 1 : 0;
    const btnName = p.button === "right" ? "right" : p.button === "middle" ? "middle" : "left";
    await mgr.sendCommand(p.tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button: btnName, buttons: 1 << btn, clickCount: 1,
    });
    await mgr.sendCommand(p.tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: btnName, buttons: 0, clickCount: 1,
    });
    const snapshot = await maybeSnapshot(mgr, p.tabId, p.includeSnapshot);
    return { ok: true as const, snapshot };
  });

  d.register("page.type", async (raw) => {
    const p = PageTypeParamsSchema.parse(raw);
    const el = await resolveElement(mgr, p.tabId, p.uid, p.selector);
    // Focus the element.
    await mgr.sendCommand(p.tabId, "Runtime.callFunctionOn", {
      objectId: el.objectId,
      functionDeclaration: `function() { this.focus(); }`,
      returnByValue: true,
    });
    if (p.clear) {
      // Select all + delete to clear.
      await mgr.sendCommand(p.tabId, "Runtime.callFunctionOn", {
        objectId: el.objectId,
        functionDeclaration: `function() {
          if ('value' in this) { this.value = ''; this.dispatchEvent(new Event('input', {bubbles:true})); }
          else if (this.isContentEditable) { this.textContent = ''; }
        }`,
        returnByValue: true,
      });
    }
    // Type via CDP insertText for framework compatibility.
    await mgr.sendCommand(p.tabId, "Input.insertText", { text: p.text });
    if (p.submit) {
      await mgr.sendCommand(p.tabId, "Runtime.callFunctionOn", {
        objectId: el.objectId,
        functionDeclaration: `function() { if (this.form) this.form.requestSubmit(); }`,
        returnByValue: true,
      });
    }
    const snapshot = await maybeSnapshot(mgr, p.tabId, p.includeSnapshot);
    return { ok: true as const, snapshot };
  });

  d.register("page.scroll", async (raw) => {
    const p = PageScrollParamsSchema.parse(raw);
    const [entry] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      func: inPageScroll,
      args: [p.dx, p.dy, p.selector, p.to, p.smooth],
    });
    if (entry && "error" in entry && entry.error) throw new Error(String(entry.error));
    const snapshot = await maybeSnapshot(mgr, p.tabId, p.includeSnapshot);
    return { ok: true as const, snapshot };
  });

  d.register("page.hover", async (raw) => {
    const p = PageHoverParamsSchema.parse(raw);
    const el = await resolveElement(mgr, p.tabId, p.uid, p.selector);
    const { x, y } = await getElementCenter(mgr, p.tabId, el.objectId);
    await mgr.sendCommand(p.tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x, y,
    });
    const snapshot = await maybeSnapshot(mgr, p.tabId, p.includeSnapshot);
    return { ok: true as const, snapshot };
  });

  d.register("page.pressKey", async (raw) => {
    const p = PagePressKeyParamsSchema.parse(raw);
    const kd = resolveKey(p.key);
    const flags = modifierFlags(p.modifiers);
    await mgr.sendCommand(p.tabId, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: kd.key,
      code: kd.code,
      windowsVirtualKeyCode: kd.keyCode,
      nativeVirtualKeyCode: kd.keyCode,
      modifiers: flags,
      text: kd.text,
    });
    await mgr.sendCommand(p.tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: kd.key,
      code: kd.code,
      windowsVirtualKeyCode: kd.keyCode,
      nativeVirtualKeyCode: kd.keyCode,
      modifiers: flags,
    });
    const snapshot = await maybeSnapshot(mgr, p.tabId, p.includeSnapshot);
    return { ok: true as const, snapshot };
  });

  d.register("page.fillForm", async (raw) => {
    const p = PageFillFormParamsSchema.parse(raw);
    let filled = 0;
    for (const field of p.fields) {
      const el = await resolveElement(mgr, p.tabId, field.uid, field.selector);
      // Focus.
      await mgr.sendCommand(p.tabId, "Runtime.callFunctionOn", {
        objectId: el.objectId,
        functionDeclaration: `function() {
          this.focus();
          if ('value' in this) { this.value = ''; this.dispatchEvent(new Event('input', {bubbles:true})); }
          else if (this.isContentEditable) { this.textContent = ''; }
        }`,
        returnByValue: true,
      });
      // Type.
      await mgr.sendCommand(p.tabId, "Input.insertText", { text: field.value });
      filled++;
    }
    if (p.submit) {
      // Submit the form of the last field.
      const lastField = p.fields[p.fields.length - 1];
      const el = await resolveElement(mgr, p.tabId, lastField.uid, lastField.selector);
      await mgr.sendCommand(p.tabId, "Runtime.callFunctionOn", {
        objectId: el.objectId,
        functionDeclaration: `function() { if (this.form) this.form.requestSubmit(); }`,
        returnByValue: true,
      });
    }
    const snapshot = await maybeSnapshot(mgr, p.tabId, p.includeSnapshot);
    return { ok: true as const, filledCount: filled, snapshot };
  });
}
