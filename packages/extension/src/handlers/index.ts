import type { Dispatcher } from "../dispatcher.js";
import { DebuggerManager } from "../lib/debugger-manager.js";
import { registerTabHandlers } from "./tabs.js";
import { registerPageHandlers } from "./page.js";
import { registerPageReadHandlers } from "./page-read.js";
import { registerPageInteractHandlers } from "./page-interact.js";
import { registerDebugHandlers } from "./debug.js";
import { registerSessionHandlers } from "./session.js";

export function registerHandlers(d: Dispatcher) {
  // Single shared DebuggerManager for all CDP-backed handlers.
  const mgr = new DebuggerManager();

  registerTabHandlers(d);
  registerPageHandlers(d);
  registerPageReadHandlers(d, mgr);
  registerPageInteractHandlers(d, mgr);
  registerDebugHandlers(d, mgr);
  registerSessionHandlers(d);
}
