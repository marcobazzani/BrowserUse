import type { Dispatcher } from "../dispatcher.js";
import { registerTabHandlers } from "./tabs.js";
import { registerPageHandlers } from "./page.js";
import { registerSessionHandlers } from "./session.js";

export function registerHandlers(d: Dispatcher) {
  registerTabHandlers(d);
  registerPageHandlers(d);
  registerSessionHandlers(d);
}
