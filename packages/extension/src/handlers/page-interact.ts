import type { Dispatcher } from "../dispatcher.js";
import type { DebuggerManager } from "../lib/debugger-manager.js";
import {
  PageClickParamsSchema,
  PageTypeParamsSchema,
  PageScrollParamsSchema,
  PageHoverParamsSchema,
  PagePressKeyParamsSchema,
  PageFillFormParamsSchema,
  PageHandleDialogParamsSchema,
  PageSelectParamsSchema,
  PageUploadFileParamsSchema,
  PageDragParamsSchema,
} from "@browseruse/shared";
import { resolveUid } from "../lib/snapshot-manager.js";
import { takeA11ySnapshot } from "./page-read.js";

/* ---------- helpers ---------- */

interface ResolvedElement {
  objectId: string;
  /** undefined = main tab frame; otherwise the OOPIF's CDP targetId. */
  targetId?: string;
}

/**
 * Resolve a uid to a CDP objectId.
 *
 * uid-based resolution picks up the element's target from the snapshot,
 * so elements inside OOPIFs route to their own CDP session. Selector-based
 * resolution always queries the main frame — selectors don't cross
 * iframe boundaries, and we don't want to introduce a surprise traversal.
 */
async function resolveElement(
  mgr: DebuggerManager,
  tabId: number,
  uid?: string,
  selector?: string,
): Promise<ResolvedElement> {
  if (uid) {
    const entry = resolveUid(tabId, uid);
    if (!entry) throw new Error(`uid "${uid}" not found — take a new snapshot first`);
    const r = await mgr.sendCommand<{ object: { objectId?: string } }>(
      tabId,
      "DOM.resolveNode",
      { backendNodeId: entry.backendNodeId },
      entry.targetId,
    );
    if (!r.object?.objectId) throw new Error(`uid "${uid}" could not be resolved to a DOM node`);
    return { objectId: r.object.objectId, targetId: entry.targetId };
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

/**
 * Get the center coordinates of an element for CDP mouse events.
 *
 * Coords are session-local: when `targetId` is set, x/y are relative to
 * the iframe's viewport and the caller must dispatch mouse events on
 * the same session for them to land.
 */
async function getElementCenter(
  mgr: DebuggerManager,
  tabId: number,
  objectId: string,
  targetId?: string,
): Promise<{ x: number; y: number }> {
  // scrollIntoViewIfNeeded first.
  await mgr.sendCommand(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() { this.scrollIntoViewIfNeeded(true); }`,
    returnByValue: true,
  }, targetId);
  const box = await mgr.sendCommand<{ model: { content: number[] } }>(
    tabId,
    "DOM.getBoxModel",
    { objectId },
    targetId,
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

/**
 * Chrome refuses CDP operations against objects inside an iframe owned by
 * another extension (typically 1Password, Bitwarden, or anti-phishing
 * overlays). We detect that error so we can fall back to coordinate-level
 * operations that don't require JS-context access to the element.
 */
function isCrossExtensionError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /chrome-extension:\/\/.*different extension/i.test(msg);
}

/** Turn opaque CDP errors into actionable advice at the tool boundary. */
function translateCdpError(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  if (isCrossExtensionError(e)) {
    return new Error(
      "interaction blocked by another Chrome extension injecting a chrome-extension:// iframe " +
      "over the target element (typically 1Password / Bitwarden autofill or an anti-phishing overlay). " +
      "Click somewhere neutral on the page to dismiss it and retry, or disable the conflicting extension " +
      "for this site. Original: " + msg,
    );
  }
  return e instanceof Error ? e : new Error(msg);
}

/** Click at element coordinates without needing JS access (works through cross-extension overlays). */
async function coordinateClick(
  mgr: DebuggerManager,
  tabId: number,
  objectId: string,
  targetId?: string,
): Promise<void> {
  const box = await mgr.sendCommand<{ model: { content: number[] } }>(
    tabId,
    "DOM.getBoxModel",
    { objectId },
    targetId,
  );
  const q = box.model.content;
  const x = (q[0] + q[2] + q[4] + q[6]) / 4;
  const y = (q[1] + q[3] + q[5] + q[7]) / 4;
  await mgr.sendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1,
  }, targetId);
  await mgr.sendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1,
  }, targetId);
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

/**
 * Send a single key (keyDown + keyUp) via CDP. Targets the focused element
 * in either the tab session or an OOPIF frame session (when targetId given).
 * Real keyboard events — required for apps that don't honor Input.insertText
 * (Office365 / Excel for the Web, Google Sheets, anything with custom input
 * pipelines).
 */
async function dispatchKey(
  mgr: DebuggerManager,
  tabId: number,
  kd: { key: string; code: string; keyCode: number; text?: string },
  modifiers: number,
  targetId?: string,
): Promise<void> {
  await mgr.sendCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: kd.key,
    code: kd.code,
    windowsVirtualKeyCode: kd.keyCode,
    nativeVirtualKeyCode: kd.keyCode,
    modifiers,
    text: kd.text,
  }, targetId);
  await mgr.sendCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: kd.key,
    code: kd.code,
    windowsVirtualKeyCode: kd.keyCode,
    nativeVirtualKeyCode: kd.keyCode,
    modifiers,
  }, targetId);
}

/**
 * Build a CDP key descriptor for a single character. Mirrors what
 * resolveKey does for single chars, plus a few common control mappings
 * (\n → Enter, \t → Tab) that page_type callers tend to embed in text.
 */
function charToKeyDef(ch: string): { key: string; code: string; keyCode: number; text?: string } {
  if (ch === "\n" || ch === "\r") return KEY_DEFS.Enter!;
  if (ch === "\t") return KEY_DEFS.Tab!;
  // Letters → KeyX; digits → DigitX; everything else falls back to the char
  // itself as code, which most apps tolerate (they read event.key/event.data).
  const upper = ch.toUpperCase();
  let code = ch;
  if (/^[A-Z]$/.test(upper)) code = `Key${upper}`;
  else if (/^[0-9]$/.test(ch)) code = `Digit${ch}`;
  else if (ch === " ") code = "Space";
  return { key: ch, code, keyCode: upper.charCodeAt(0), text: ch };
}

/* ---------- handlers ---------- */

export function registerPageInteractHandlers(d: Dispatcher, mgr: DebuggerManager) {
  d.register("page.click", async (raw) => {
    const p = PageClickParamsSchema.parse(raw);
    const el = await resolveElement(mgr, p.tabId, p.uid, p.selector);
    const { x, y } = await getElementCenter(mgr, p.tabId, el.objectId, el.targetId);
    const btn = p.button === "right" ? 2 : p.button === "middle" ? 1 : 0;
    const btnName = p.button === "right" ? "right" : p.button === "middle" ? "middle" : "left";
    await mgr.sendCommand(p.tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button: btnName, buttons: 1 << btn, clickCount: 1,
    }, el.targetId);
    await mgr.sendCommand(p.tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: btnName, buttons: 0, clickCount: 1,
    }, el.targetId);
    const snapshot = await maybeSnapshot(mgr, p.tabId, p.includeSnapshot);
    return { ok: true as const, snapshot };
  });

  d.register("page.type", async (raw) => {
    const p = PageTypeParamsSchema.parse(raw);
    let el;
    try {
      el = await resolveElement(mgr, p.tabId, p.uid, p.selector);
    } catch (e) {
      throw translateCdpError(e);
    }

    // Primary path: focus+clear via JS. Falls through to coordinate-click when
    // the element sits inside another extension's iframe (1Password autofill,
    // anti-phishing overlays) and Chrome refuses JS access.
    let usedFallback = false;
    try {
      await mgr.sendCommand(p.tabId, "Runtime.callFunctionOn", {
        objectId: el.objectId,
        functionDeclaration: `function() { this.focus(); }`,
        returnByValue: true,
      }, el.targetId);
    } catch (e) {
      if (!isCrossExtensionError(e)) throw translateCdpError(e);
      usedFallback = true;
      try {
        await coordinateClick(mgr, p.tabId, el.objectId, el.targetId);
      } catch (ce) {
        throw translateCdpError(ce);
      }
    }

    if (p.clear && !usedFallback) {
      await mgr.sendCommand(p.tabId, "Runtime.callFunctionOn", {
        objectId: el.objectId,
        functionDeclaration: `function() {
          if ('value' in this) { this.value = ''; this.dispatchEvent(new Event('input', {bubbles:true})); }
          else if (this.isContentEditable) { this.textContent = ''; }
        }`,
        returnByValue: true,
      }, el.targetId).catch((e) => { if (!isCrossExtensionError(e)) throw translateCdpError(e); });
    }
    // In fallback mode we can't read the field; a Ctrl/Cmd+A + Delete keyboard
    // sequence would clear but is platform-dependent — we skip clear rather
    // than risk firing the wrong key combo. Most login fields are empty anyway.

    // Type as real keystrokes (keyDown + keyUp per char) via CDP.
    // Input.insertText would be faster but it bypasses the keyboard event
    // pipeline that some apps (Office365 / Excel for the Web, Google Sheets,
    // Figma, anything with custom input handling) rely on to commit values.
    // Real keystrokes work in both standard inputs and these custom surfaces.
    try {
      for (const ch of p.text) {
        await dispatchKey(mgr, p.tabId, charToKeyDef(ch), 0, el.targetId);
      }
    } catch (e) {
      throw translateCdpError(e);
    }

    if (p.submit && !usedFallback) {
      await mgr.sendCommand(p.tabId, "Runtime.callFunctionOn", {
        objectId: el.objectId,
        functionDeclaration: `function() { if (this.form) this.form.requestSubmit(); }`,
        returnByValue: true,
      }, el.targetId).catch((e) => { if (!isCrossExtensionError(e)) throw translateCdpError(e); });
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
    const { x, y } = await getElementCenter(mgr, p.tabId, el.objectId, el.targetId);
    await mgr.sendCommand(p.tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x, y,
    }, el.targetId);
    const snapshot = await maybeSnapshot(mgr, p.tabId, p.includeSnapshot);
    return { ok: true as const, snapshot };
  });

  d.register("page.pressKey", async (raw) => {
    const p = PagePressKeyParamsSchema.parse(raw);
    await dispatchKey(mgr, p.tabId, resolveKey(p.key), modifierFlags(p.modifiers));
    const snapshot = await maybeSnapshot(mgr, p.tabId, p.includeSnapshot);
    return { ok: true as const, snapshot };
  });

  d.register("page.fillForm", async (raw) => {
    const p = PageFillFormParamsSchema.parse(raw);
    let filled = 0;
    for (const field of p.fields) {
      const el = await resolveElement(mgr, p.tabId, field.uid, field.selector);
      // Focus + clear via JS; fall back to coordinate click when blocked by another extension.
      let usedFallback = false;
      try {
        await mgr.sendCommand(p.tabId, "Runtime.callFunctionOn", {
          objectId: el.objectId,
          functionDeclaration: `function() {
            this.focus();
            if ('value' in this) { this.value = ''; this.dispatchEvent(new Event('input', {bubbles:true})); }
            else if (this.isContentEditable) { this.textContent = ''; }
          }`,
          returnByValue: true,
        }, el.targetId);
      } catch (e) {
        if (!isCrossExtensionError(e)) throw translateCdpError(e);
        usedFallback = true;
        try {
          await coordinateClick(mgr, p.tabId, el.objectId, el.targetId);
        } catch (ce) {
          throw translateCdpError(ce);
        }
      }
      try {
        for (const ch of field.value) {
          await dispatchKey(mgr, p.tabId, charToKeyDef(ch), 0, el.targetId);
        }
      } catch (e) {
        throw translateCdpError(e);
      }
      filled++;
      // Nudge the cached usedFallback so tsc knows it's observed.
      void usedFallback;
    }
    if (p.submit) {
      const lastField = p.fields[p.fields.length - 1];
      const el = await resolveElement(mgr, p.tabId, lastField!.uid, lastField!.selector);
      await mgr.sendCommand(p.tabId, "Runtime.callFunctionOn", {
        objectId: el.objectId,
        functionDeclaration: `function() { if (this.form) this.form.requestSubmit(); }`,
        returnByValue: true,
      }, el.targetId).catch((e) => { if (!isCrossExtensionError(e)) throw translateCdpError(e); });
    }
    const snapshot = await maybeSnapshot(mgr, p.tabId, p.includeSnapshot);
    return { ok: true as const, filledCount: filled, snapshot };
  });

  d.register("page.handleDialog", async (raw) => {
    const p = PageHandleDialogParamsSchema.parse(raw);
    const pending = mgr.getPendingDialog(p.tabId);
    if (!pending) {
      // No dialog open — nothing to do. Report it honestly rather than throwing.
      return { ok: true as const, handled: false };
    }
    const payload: Record<string, unknown> = { accept: p.action === "accept" };
    if (p.promptText !== undefined) payload.promptText = p.promptText;
    await mgr.sendCommand(p.tabId, "Page.handleJavaScriptDialog", payload);
    mgr.clearPendingDialog(p.tabId);
    return {
      ok: true as const,
      handled: true,
      dialogType: pending.type,
      dialogMessage: pending.message,
    };
  });

  d.register("page.select", async (raw) => {
    const p = PageSelectParamsSchema.parse(raw);
    const el = await resolveElement(mgr, p.tabId, p.uid, p.selector);
    // Set selected options by value-or-text match. Dispatch change/input events.
    const result = await mgr.sendCommand<{ result: { value: string[] } }>(
      p.tabId,
      "Runtime.callFunctionOn",
      {
        objectId: el.objectId,
        functionDeclaration: `function(values) {
          if (this.tagName !== 'SELECT') {
            throw new Error('page.select target is not a <select> element: ' + this.tagName);
          }
          const wanted = new Set(values);
          const picked = [];
          for (const opt of this.options) {
            const match = wanted.has(opt.value) || wanted.has(opt.label) || wanted.has(opt.textContent?.trim() ?? '');
            opt.selected = match;
            if (match) picked.push(opt.value);
          }
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
          return picked;
        }`,
        arguments: [{ value: p.values }],
        returnByValue: true,
      },
      el.targetId,
    );
    const snapshot = await maybeSnapshot(mgr, p.tabId, p.includeSnapshot);
    return { ok: true as const, selected: result.result.value ?? [], snapshot };
  });

  d.register("page.uploadFile", async (raw) => {
    const p = PageUploadFileParamsSchema.parse(raw);
    const el = await resolveElement(mgr, p.tabId, p.uid, p.selector);
    await mgr.sendCommand(p.tabId, "DOM.setFileInputFiles", {
      files: p.filePaths,
      objectId: el.objectId,
    }, el.targetId);
    // Dispatch input/change so frameworks notice the file list changed.
    await mgr.sendCommand(p.tabId, "Runtime.callFunctionOn", {
      objectId: el.objectId,
      functionDeclaration: `function() {
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
      }`,
      returnByValue: true,
    }, el.targetId);
    const snapshot = await maybeSnapshot(mgr, p.tabId, p.includeSnapshot);
    return { ok: true as const, uploadedCount: p.filePaths.length, snapshot };
  });

  d.register("page.drag", async (raw) => {
    const p = PageDragParamsSchema.parse(raw);
    const from = await resolveElement(mgr, p.tabId, p.fromUid, p.fromSelector);
    const to = await resolveElement(mgr, p.tabId, p.toUid, p.toSelector);
    // Drag across frame boundaries would need per-event coordinate translation
    // into whichever frame the pointer is currently inside. We don't support
    // that; require both endpoints in the same frame (including both == main).
    if (from.targetId !== to.targetId) {
      throw new Error(
        "page.drag endpoints live in different frames; cross-frame drag is not supported",
      );
    }
    const dragTarget = from.targetId;
    const fromC = await getElementCenter(mgr, p.tabId, from.objectId, dragTarget);
    const toC = await getElementCenter(mgr, p.tabId, to.objectId, dragTarget);
    const targetX = toC.x + (p.toOffsetX ?? 0);
    const targetY = toC.y + (p.toOffsetY ?? 0);

    // Press at source.
    await mgr.sendCommand(p.tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed", x: fromC.x, y: fromC.y, button: "left", buttons: 1, clickCount: 1,
    }, dragTarget);
    // Move in steps (HTML5 drag needs multiple move events between press and release).
    for (let i = 1; i <= p.steps; i++) {
      const t = i / p.steps;
      const x = fromC.x + (targetX - fromC.x) * t;
      const y = fromC.y + (targetY - fromC.y) * t;
      await mgr.sendCommand(p.tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved", x, y, button: "left", buttons: 1,
      }, dragTarget);
    }
    // Release at target.
    await mgr.sendCommand(p.tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x: targetX, y: targetY, button: "left", buttons: 0, clickCount: 1,
    }, dragTarget);

    const snapshot = await maybeSnapshot(mgr, p.tabId, p.includeSnapshot);
    return { ok: true as const, snapshot };
  });
}
