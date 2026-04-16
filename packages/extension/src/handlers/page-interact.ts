import type { Dispatcher } from "../dispatcher.js";
import {
  PageClickParamsSchema,
  PageTypeParamsSchema,
  PageScrollParamsSchema,
} from "@browseruse/shared";

// Runs in-page. Must be self-contained (no closures over outer scope).
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
    // Set value via the native property descriptor so frameworks (React/Vue) observe the change.
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    const next = (el.value ?? "") + text;
    if (setter) setter.call(el, next); else (el as HTMLInputElement).value = next;
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

function inPageScroll(
  dx: number | undefined,
  dy: number | undefined,
  selector: string | undefined,
  to: "top" | "bottom" | undefined,
  smooth: boolean
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

export function registerPageInteractHandlers(d: Dispatcher) {
  d.register("page.click", async (raw) => {
    const p = PageClickParamsSchema.parse(raw);
    const [entry] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      func: inPageClick,
      args: [p.selector, p.button, p.scrollIntoView],
    });
    // executeScript results use the string "error" form when the injected function throws.
    if (entry && "error" in entry && entry.error) throw new Error(String(entry.error));
    return entry?.result;
  });

  d.register("page.type", async (raw) => {
    const p = PageTypeParamsSchema.parse(raw);
    const [entry] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      func: inPageType,
      args: [p.selector, p.text, p.submit, p.clear],
    });
    if (entry && "error" in entry && entry.error) throw new Error(String(entry.error));
    return entry?.result;
  });

  d.register("page.scroll", async (raw) => {
    const p = PageScrollParamsSchema.parse(raw);
    const [entry] = await chrome.scripting.executeScript({
      target: { tabId: p.tabId },
      func: inPageScroll,
      args: [p.dx, p.dy, p.selector, p.to, p.smooth],
    });
    if (entry && "error" in entry && entry.error) throw new Error(String(entry.error));
    return entry?.result;
  });
}
