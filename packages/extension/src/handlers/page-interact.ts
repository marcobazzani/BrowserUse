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
  PageFocusParamsSchema,
  PageClickXyParamsSchema,
  PageFocusStateParamsSchema,
} from "@chromanche/shared";
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

/* ---------- Focus verification + escalation ---------- */

interface FocusActualState {
  matches: boolean;
  actualTag?: string;
  actualRole?: string | null;
  actualName?: string;
}

/**
 * Ask the page whether `el` is its document's activeElement. When it isn't,
 * report what activeElement actually is — so the caller can either escalate
 * (coordinate-click, blur+click) or surface a structured error to the model.
 *
 * Runs in the element's own document via the same CDP session we used to
 * resolve it, which is critical for OOPIFs (Excel for the Web's grid lives
 * inside an Office iframe).
 */
async function verifyFocus(
  mgr: DebuggerManager,
  tabId: number,
  el: ResolvedElement,
): Promise<FocusActualState> {
  const r = await mgr.sendCommand<{ result: { value: FocusActualState } }>(
    tabId,
    "Runtime.callFunctionOn",
    {
      objectId: el.objectId,
      functionDeclaration: `function() {
        var doc = this.ownerDocument;
        var active = doc && doc.activeElement;
        if (active === this) return { matches: true };
        return {
          matches: false,
          actualTag: active && active.tagName ? active.tagName.toLowerCase() : 'body',
          actualRole: active && active.getAttribute ? active.getAttribute('role') : null,
          actualName: active ? (
            (active.getAttribute && (active.getAttribute('aria-label') || active.getAttribute('placeholder') || active.getAttribute('name'))) ||
            (active.textContent || '').trim().slice(0, 80)
          ) : ''
        };
      }`,
      returnByValue: true,
    },
    el.targetId,
  );
  return r.result.value;
}

/** Plain JS focus(), idempotent: skips when the element is already active. */
async function jsFocus(mgr: DebuggerManager, tabId: number, el: ResolvedElement): Promise<void> {
  await mgr.sendCommand(tabId, "Runtime.callFunctionOn", {
    objectId: el.objectId,
    functionDeclaration: `function() { if (this.ownerDocument && this !== this.ownerDocument.activeElement) this.focus(); }`,
    returnByValue: true,
  }, el.targetId);
}

/** document.activeElement.blur() inside the element's own document — drops sticky focus. */
async function blurActive(mgr: DebuggerManager, tabId: number, el: ResolvedElement): Promise<void> {
  await mgr.sendCommand(tabId, "Runtime.callFunctionOn", {
    objectId: el.objectId,
    functionDeclaration: `function() {
      var doc = this.ownerDocument;
      var a = doc && doc.activeElement;
      if (a && a !== this && typeof a.blur === 'function') a.blur();
    }`,
    returnByValue: true,
  }, el.targetId);
}

interface FocusOutcome {
  focused: boolean;
  modeUsed: "js" | "click" | "blur+click";
  actual?: FocusActualState;
}

/**
 * Auto mode: try the gentle JS focus, verify, escalate to coordinate-click on
 * mismatch, verify again. Returns the outcome — never throws on focus
 * mismatch; callers decide whether mismatch is fatal (page.type makes it so;
 * page.focus reports it back to the model).
 */
async function focusAuto(
  mgr: DebuggerManager,
  tabId: number,
  el: ResolvedElement,
): Promise<FocusOutcome> {
  await jsFocus(mgr, tabId, el);
  let v = await verifyFocus(mgr, tabId, el);
  if (v.matches) return { focused: true, modeUsed: "js" };
  // Escalate: real coordinate click. Reaches the OS-level focus router and
  // dislodges most apps' internal focus management.
  await coordinateClick(mgr, tabId, el.objectId, el.targetId);
  v = await verifyFocus(mgr, tabId, el);
  return { focused: v.matches, modeUsed: "click", actual: v.matches ? undefined : v };
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
  F1:         { key: "F1",        code: "F1",          keyCode: 112 },
  F2:         { key: "F2",        code: "F2",          keyCode: 113 },
  F3:         { key: "F3",        code: "F3",          keyCode: 114 },
  F4:         { key: "F4",        code: "F4",          keyCode: 115 },
  F5:         { key: "F5",        code: "F5",          keyCode: 116 },
  F6:         { key: "F6",        code: "F6",          keyCode: 117 },
  F7:         { key: "F7",        code: "F7",          keyCode: 118 },
  F8:         { key: "F8",        code: "F8",          keyCode: 119 },
  F9:         { key: "F9",        code: "F9",          keyCode: 120 },
  F10:        { key: "F10",       code: "F10",         keyCode: 121 },
  F11:        { key: "F11",       code: "F11",         keyCode: 122 },
  F12:        { key: "F12",       code: "F12",         keyCode: 123 },
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

async function documentHasFocus(
  mgr: DebuggerManager,
  tabId: number,
  targetId?: string,
): Promise<boolean> {
  try {
    const r = await mgr.sendCommand<{ result: { value?: boolean } }>(
      tabId,
      "Runtime.evaluate",
      { expression: "document.hasFocus()", returnByValue: true },
      targetId,
    );
    return r.result.value === true;
  } catch {
    return false;
  }
}

function frameDepth(targetId: string, parents: Map<string, string | undefined>): number {
  let depth = 0;
  let cur: string | undefined = targetId;
  while (cur) {
    depth++;
    cur = parents.get(cur);
  }
  return depth;
}

/**
 * Dispatch at the page's actual focused document. Virtualized editors often
 * keep their active surface inside an OOPIF; sending arrows/Tab/Enter only
 * to the top tab session can miss the frame that owns focus.
 */
async function focusedKeyboardTarget(
  mgr: DebuggerManager,
  tabId: number,
): Promise<string | undefined> {
  await mgr.syncFrameTargets(tabId);
  const frames = mgr.getFrameTargets(tabId);
  const parents = new Map(frames.map((f) => [f.targetId, f.parentTargetId]));
  const deepestFirst = [...frames]
    .sort((a, b) => frameDepth(b.targetId, parents) - frameDepth(a.targetId, parents));

  for (const frame of deepestFirst) {
    if (await documentHasFocus(mgr, tabId, frame.targetId)) {
      return frame.targetId;
    }
  }

  return undefined;
}

async function dispatchKeyAtCurrentFocus(
  mgr: DebuggerManager,
  tabId: number,
  kd: { key: string; code: string; keyCode: number; text?: string },
  modifiers: number,
): Promise<void> {
  await dispatchKey(mgr, tabId, kd, modifiers, await focusedKeyboardTarget(mgr, tabId));
}

interface FocusState {
  ok: true;
  targetId?: string;
  url: string;
  title: string;
  documentHasFocus: boolean;
  activeTag: string;
  activeRole?: string | null;
  activeName?: string;
  activeValue?: string;
  activeText?: string;
  selectedText?: string;
  selectionStart?: number | null;
  selectionEnd?: number | null;
  activeDescendant?: string;
  activeDescendantTag?: string;
  activeDescendantRole?: string | null;
  activeDescendantName?: string;
  activeDescendantValue?: string;
  activeDescendantText?: string;
  activeDescendantRowIndex?: string;
  activeDescendantColIndex?: string;
  activeDescendantBounds?: { x: number; y: number; width: number; height: number };
  ariaRowIndex?: string;
  ariaColIndex?: string;
}

async function readFocusState(
  mgr: DebuggerManager,
  tabId: number,
  targetId?: string,
): Promise<FocusState> {
  const r = await mgr.sendCommand<{ result: { value: Omit<FocusState, "ok" | "targetId"> } }>(
    tabId,
    "Runtime.evaluate",
    {
      expression: `(() => {
        const doc = document;
        const active = doc.activeElement;
        const readAttr = (el, name) => el && el.getAttribute ? el.getAttribute(name) || undefined : undefined;
        const accessibleName = (el) => el ? (
          readAttr(el, "aria-label") ||
          readAttr(el, "placeholder") ||
          readAttr(el, "name") ||
          readAttr(el, "title") ||
          (el.textContent || "").trim().slice(0, 200) ||
          undefined
        ) : undefined;
        const elementValue = (el) => el && "value" in el ? String(el.value ?? "") : undefined;
        const elementText = (el, max = 500) => el ? (el.textContent || "").trim().slice(0, max) || undefined : undefined;
        const bounds = (el) => {
          if (!el || typeof el.getBoundingClientRect !== "function") return undefined;
          const r = el.getBoundingClientRect();
          if (!Number.isFinite(r.width) || !Number.isFinite(r.height)) return undefined;
          return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
        };
        const value = active && "value" in active ? String(active.value ?? "") : undefined;
        const selectionStart = active && "selectionStart" in active ? active.selectionStart : undefined;
        const selectionEnd = active && "selectionEnd" in active ? active.selectionEnd : undefined;
        let selectedText = "";
        if (typeof selectionStart === "number" && typeof selectionEnd === "number" && value !== undefined) {
          selectedText = value.slice(selectionStart, selectionEnd);
        } else {
          selectedText = String(doc.getSelection ? doc.getSelection() || "" : "");
        }
        const activeDescendant = readAttr(active, "aria-activedescendant");
        const descendant = activeDescendant ? doc.getElementById(activeDescendant) : null;
        return {
          url: location.href,
          title: doc.title,
          documentHasFocus: doc.hasFocus(),
          activeTag: active && active.tagName ? active.tagName.toLowerCase() : "body",
          activeRole: readAttr(active, "role") ?? null,
          activeName: accessibleName(active),
          activeValue: elementValue(active),
          activeText: elementText(active),
          selectedText: selectedText || undefined,
          selectionStart: selectionStart ?? undefined,
          selectionEnd: selectionEnd ?? undefined,
          activeDescendant,
          activeDescendantTag: descendant && descendant.tagName ? descendant.tagName.toLowerCase() : undefined,
          activeDescendantRole: readAttr(descendant, "role") ?? undefined,
          activeDescendantName: accessibleName(descendant),
          activeDescendantValue: elementValue(descendant),
          activeDescendantText: elementText(descendant),
          activeDescendantRowIndex: readAttr(descendant, "aria-rowindex"),
          activeDescendantColIndex: readAttr(descendant, "aria-colindex"),
          activeDescendantBounds: bounds(descendant),
          ariaRowIndex: readAttr(active, "aria-rowindex"),
          ariaColIndex: readAttr(active, "aria-colindex"),
        };
      })()`,
      returnByValue: true,
    },
    targetId,
  );
  return { ok: true, targetId, ...r.result.value };
}

function firstNonEmptyText(state: FocusState): { source: string; text: string } | undefined {
  const candidates: Array<[string, string | undefined]> = state.activeDescendant
    ? [
        ["activeDescendantValue", state.activeDescendantValue],
        ["activeDescendantText", state.activeDescendantText],
        ["activeValue", state.activeValue],
        ["selectedText", state.selectedText],
      ]
    : [
        ["activeValue", state.activeValue],
        ["activeText", state.activeText],
        ["selectedText", state.selectedText],
      ];

  for (const [source, text] of candidates) {
    const trimmed = text?.trim();
    if (trimmed) return { source, text: trimmed };
  }
  return undefined;
}

async function assertEmptyFocusTarget(
  mgr: DebuggerManager,
  tabId: number,
  targetId?: string,
): Promise<void> {
  const state = await readFocusState(mgr, tabId, targetId);
  const existing = firstNonEmptyText(state);
  if (!existing) return;
  const location = state.activeDescendant
    ? `active descendant ${state.activeDescendant}` +
      `${state.activeDescendantRowIndex ? ` row=${state.activeDescendantRowIndex}` : ""}` +
      `${state.activeDescendantColIndex ? ` col=${state.activeDescendantColIndex}` : ""}`
    : `active <${state.activeTag} role="${state.activeRole ?? ""}">`;
  throw new Error(
    `page.type requireEmpty refused to type because ${location} already has ${existing.source}="${existing.text.slice(0, 120)}". ` +
    `Use page_focus_state/page_screenshot to verify the target, then clear or choose another cell before typing.`,
  );
}

/**
 * US-keyboard virtual key codes for punctuation. Critical for typing into
 * apps that branch on keyCode at the keydown level (Excel for the Web,
 * Sheets, anything with custom shortcut handling). Without this map, "." was
 * dispatched with keyCode 46 — which is Delete — and Excel ate the period
 * during edit-mode insertion, silently corrupting emails, URLs, decimals.
 *
 * Sources: KeyboardEvent.keyCode legacy table (Mozilla docs), windows
 * virtual-key codes for the standard US layout.
 */
const PUNCT_KEYCODES: Record<string, { code: string; keyCode: number }> = {
  " ":  { code: "Space",        keyCode: 32  },
  ".":  { code: "Period",       keyCode: 190 },
  ",":  { code: "Comma",        keyCode: 188 },
  ";":  { code: "Semicolon",    keyCode: 186 },
  "'":  { code: "Quote",        keyCode: 222 },
  "/":  { code: "Slash",        keyCode: 191 },
  "\\": { code: "Backslash",    keyCode: 220 },
  "[":  { code: "BracketLeft",  keyCode: 219 },
  "]":  { code: "BracketRight", keyCode: 221 },
  "-":  { code: "Minus",        keyCode: 189 },
  "=":  { code: "Equal",        keyCode: 187 },
  "`":  { code: "Backquote",    keyCode: 192 },
};

/**
 * Build a CDP key descriptor for a single character. Mirrors what resolveKey
 * does for single chars, plus a few common control mappings (\n → Enter, \t
 * → Tab) that page_type callers tend to embed in text.
 *
 * For characters we don't have a deterministic virtual-key for (every
 * non-letter, non-digit, non-mapped-punctuation), we send windowsVirtualKey-
 * Code 0 so apps don't accidentally fire shortcut handlers — the `text`
 * field is what gets inserted regardless.
 */
function charToKeyDef(ch: string): { key: string; code: string; keyCode: number; text?: string } {
  if (ch === "\n" || ch === "\r") return KEY_DEFS.Enter!;
  if (ch === "\t") return KEY_DEFS.Tab!;
  const upper = ch.toUpperCase();
  if (/^[A-Z]$/.test(upper)) {
    return { key: ch, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: ch };
  }
  if (/^[0-9]$/.test(ch)) {
    return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), text: ch };
  }
  const punct = PUNCT_KEYCODES[ch];
  if (punct) return { key: ch, code: punct.code, keyCode: punct.keyCode, text: ch };
  // Unknown character (shifted punctuation like @, extended ASCII, accented
  // letters, emoji): keep `code` non-empty (CDP/Chrome rejects empty code in
  // some versions and crashes the dispatch) but use windowsVirtualKeyCode 0
  // so apps don't accidentally fire shortcut/control handlers tied to
  // ambiguous keyCodes. The `text` field is what gets inserted.
  return { key: ch, code: ch, keyCode: 0, text: ch };
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

  // page.clickXy: dispatch a click at absolute viewport coords. The model
  // discovers coords visually from a screenshot — the escape hatch for
  // virtual-canvas widgets where uid bbox centers don't map to anything
  // meaningful (Excel grid cells, Sheets, Figma). No element resolution,
  // no targetId — coordinates are top-frame-viewport relative, which
  // matches the screenshot the model is reading from.
  d.register("page.clickXy", async (raw) => {
    const p = PageClickXyParamsSchema.parse(raw);
    const btn = p.button === "right" ? 2 : p.button === "middle" ? 1 : 0;
    const btnName = p.button === "right" ? "right" : p.button === "middle" ? "middle" : "left";
    for (let i = 1; i <= p.clickCount; i++) {
      await mgr.sendCommand(p.tabId, "Input.dispatchMouseEvent", {
        type: "mousePressed", x: p.x, y: p.y, button: btnName, buttons: 1 << btn, clickCount: i,
      });
      await mgr.sendCommand(p.tabId, "Input.dispatchMouseEvent", {
        type: "mouseReleased", x: p.x, y: p.y, button: btnName, buttons: 0, clickCount: i,
      });
    }
    const snapshot = await maybeSnapshot(mgr, p.tabId, p.includeSnapshot);
    return { ok: true as const, snapshot };
  });

  d.register("page.type", async (raw) => {
    const p = PageTypeParamsSchema.parse(raw);

    // No-target path: no uid, no selector → dispatch keystrokes at the current
    // focus without resolving or focusing any element. Mirrors Claude in
    // Chrome's `type` action and is the canonical primitive for typing into
    // a virtual-canvas cell after page_click_xy lands focus there.
    if (!p.uid && !p.selector) {
      try {
        const targetId = await focusedKeyboardTarget(mgr, p.tabId);
        if (p.requireEmpty) await assertEmptyFocusTarget(mgr, p.tabId, targetId);
        for (const ch of p.text) {
          await dispatchKey(mgr, p.tabId, charToKeyDef(ch), 0, targetId);
        }
      } catch (e) {
        throw translateCdpError(e);
      }
      const snapshot = await maybeSnapshot(mgr, p.tabId, p.includeSnapshot);
      return { ok: true as const, snapshot };
    }

    let el;
    try {
      el = await resolveElement(mgr, p.tabId, p.uid, p.selector);
    } catch (e) {
      throw translateCdpError(e);
    }

    // Self-verifying focus: JS focus → verify → escalate to coordinate-click
    // on mismatch → verify again. If both attempts fail we throw a structured
    // error including what activeElement actually became, so the caller can
    // route to page.focus or app-specific anchors instead of typing into
    // the void. Cross-extension iframes (1Password etc.) keep their own
    // coordinate-click fallback path because Chrome refuses JS access there.
    let usedFallback = false;
    let outcome: FocusOutcome;
    try {
      outcome = await focusAuto(mgr, p.tabId, el);
    } catch (e) {
      if (!isCrossExtensionError(e)) throw translateCdpError(e);
      usedFallback = true;
      try {
        await coordinateClick(mgr, p.tabId, el.objectId, el.targetId);
      } catch (ce) {
        throw translateCdpError(ce);
      }
      outcome = { focused: true, modeUsed: "click" };
    }
    if (!outcome.focused) {
      const a = outcome.actual!;
      throw new Error(
        `page.type couldn't focus the target — activeElement is <${a.actualTag} role="${a.actualRole ?? ""}" name="${a.actualName ?? ""}">. ` +
        `The page is grabbing focus elsewhere (common in Excel/Sheets/Figma). ` +
        `Try page.focus(uid, mode: "blur+click") or use an app-specific anchor.`,
      );
    }

    if (p.requireEmpty) await assertEmptyFocusTarget(mgr, p.tabId, el.targetId);

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

  d.register("page.focus", async (raw) => {
    const p = PageFocusParamsSchema.parse(raw);
    const el = await resolveElement(mgr, p.tabId, p.uid, p.selector);

    let modeUsed: "js" | "click" | "blur+click";
    if (p.mode === "js") {
      await jsFocus(mgr, p.tabId, el);
      modeUsed = "js";
    } else if (p.mode === "click") {
      await coordinateClick(mgr, p.tabId, el.objectId, el.targetId);
      modeUsed = "click";
    } else if (p.mode === "blur+click") {
      await blurActive(mgr, p.tabId, el);
      await coordinateClick(mgr, p.tabId, el.objectId, el.targetId);
      modeUsed = "blur+click";
    } else {
      // auto: gentle then aggressive, mirroring page.type's path.
      const out = await focusAuto(mgr, p.tabId, el);
      const v = await verifyFocus(mgr, p.tabId, el);
      const snapshot = await maybeSnapshot(mgr, p.tabId, p.includeSnapshot);
      return {
        ok: true as const,
        focused: v.matches,
        modeUsed: out.modeUsed,
        actualTag: v.matches ? undefined : v.actualTag,
        actualRole: v.matches ? undefined : v.actualRole,
        actualName: v.matches ? undefined : v.actualName,
        snapshot,
      };
    }

    const v = await verifyFocus(mgr, p.tabId, el);
    const snapshot = await maybeSnapshot(mgr, p.tabId, p.includeSnapshot);
    return {
      ok: true as const,
      focused: v.matches,
      modeUsed,
      actualTag: v.matches ? undefined : v.actualTag,
      actualRole: v.matches ? undefined : v.actualRole,
      actualName: v.matches ? undefined : v.actualName,
      snapshot,
    };
  });

  d.register("page.pressKey", async (raw) => {
    const p = PagePressKeyParamsSchema.parse(raw);
    await dispatchKeyAtCurrentFocus(mgr, p.tabId, resolveKey(p.key), modifierFlags(p.modifiers));
    const snapshot = await maybeSnapshot(mgr, p.tabId, p.includeSnapshot);
    return { ok: true as const, snapshot };
  });

  d.register("page.focusState", async (raw) => {
    const p = PageFocusStateParamsSchema.parse(raw);
    return readFocusState(mgr, p.tabId, await focusedKeyboardTarget(mgr, p.tabId));
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
