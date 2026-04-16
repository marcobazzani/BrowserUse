import type { Dispatcher } from "../dispatcher.js";
import { DebuggerManager } from "../lib/debugger-manager.js";
import { resolveTabId } from "../lib/active-tab.js";
import {
  PageEvalJsParamsSchema,
  ConsoleReadParamsSchema,
  NetworkReadParamsSchema,
} from "@browseruse/shared";

// Module-level singleton — service-worker is a single-instance environment.
const mgr = new DebuggerManager();

type RuntimeEvaluateResult = {
  result: { type: string; value?: unknown; description?: string };
  exceptionDetails?: { text: string };
};

export function registerDebugHandlers(d: Dispatcher) {
  d.register("page.evalJs", async (raw) => {
    const p = PageEvalJsParamsSchema.parse(raw);
    const tabId = await resolveTabId(p.tabId);
    const r = await mgr.sendCommand<RuntimeEvaluateResult>(tabId, "Runtime.evaluate", {
      expression: p.expression,
      awaitPromise: p.awaitPromise,
      returnByValue: p.returnByValue,
      timeout: p.timeoutMs,
    });
    if (r.exceptionDetails) {
      return { type: "exception", exception: r.exceptionDetails.text };
    }
    return {
      type: r.result.type,
      value: r.result.value,
      description: r.result.description,
    };
  });

  d.register("console.read", async (raw) => {
    const p = ConsoleReadParamsSchema.parse(raw);
    const tabId = await resolveTabId(p.tabId);
    await mgr.attach(tabId); // idempotent — ensures a buffer exists even before any event fires
    return mgr.readConsole(tabId, p.pattern, p.since, p.limit);
  });

  d.register("network.read", async (raw) => {
    const p = NetworkReadParamsSchema.parse(raw);
    const tabId = await resolveTabId(p.tabId);
    await mgr.attach(tabId);
    return mgr.readNetwork(tabId, p.pattern, p.since, p.limit);
  });
}

// Exposed for unit tests so they can inject a fake manager.
export const _debugInternals = { mgr };
