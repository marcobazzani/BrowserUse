import type { Dispatcher } from "../dispatcher.js";
import { registerTabHandlers } from "./tabs.js";
import { registerPageHandlers } from "./page.js";
import { registerPageReadHandlers } from "./page-read.js";
import { registerSessionHandlers } from "./session.js";

export function registerHandlers(d: Dispatcher) {
  registerTabHandlers(d);
  registerPageHandlers(d);
  registerPageReadHandlers(d);
  registerSessionHandlers(d);
}
