import type { Dispatcher } from "../dispatcher.js";
import { DebuggerManager } from "../lib/debugger-manager.js";
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
    const r = await mgr.sendCommand<RuntimeEvaluateResult>(p.tabId, "Runtime.evaluate", {
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
    await mgr.attach(p.tabId); // idempotent — ensures a buffer exists even before any event fires
    return mgr.readConsole(p.tabId, p.pattern, p.since, p.limit);
  });

  d.register("network.read", async (raw) => {
    const p = NetworkReadParamsSchema.parse(raw);
    await mgr.attach(p.tabId);
    return mgr.readNetwork(p.tabId, p.pattern, p.since, p.limit);
  });
}

// Exposed for unit tests so they can inject a fake manager.
export const _debugInternals = { mgr };
