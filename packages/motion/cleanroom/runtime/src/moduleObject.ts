// The module object that `require("remotion")` returns in a graphic (BRIEF section 5).

import { graphicError, misuse, unsupportedNameMessage } from "./errors";
import { EXPORT_NAMES } from "./exportNames";
import type { MotionHost } from "./hostTypes";
import * as api from "./index";
import { makeHostRandom } from "./random";
import { sessionForModule } from "./session";

const READ_ONLY = "The graphics module object cannot be changed. Keep your own values in your own variables.";

export function createModuleObject(host: MotionHost): object {
  const session = sessionForModule(host);
  const values = new Map<string, unknown>();
  for (const name of EXPORT_NAMES) values.set(name, (api as Record<string, unknown>)[name]);
  values.set("delayRender", session.delayRender);
  values.set("continueRender", session.continueRender);
  values.set("cancelRender", session.cancelRender);
  values.set("loadFont", session.loadFont);
  values.set("random", makeHostRandom(host));

  return new Proxy(Object.create(null) as object, {
    get(_target, property) {
      if (typeof property === "symbol") return undefined;
      if (property === "__esModule") return true;
      if (property === "then") return undefined;
      if (values.has(property)) return values.get(property);
      throw graphicError("graphic_api_unsupported", unsupportedNameMessage(property));
    },
    has(_target, property) {
      return typeof property === "string" && (property === "__esModule" || values.has(property));
    },
    ownKeys() {
      return [...values.keys()];
    },
    getOwnPropertyDescriptor(_target, property) {
      if (typeof property !== "string" || !values.has(property)) return undefined;
      return { value: values.get(property), writable: false, enumerable: true, configurable: true };
    },
    set() {
      throw misuse(READ_ONLY);
    },
    defineProperty() {
      throw misuse(READ_ONLY);
    },
    deleteProperty() {
      throw misuse(READ_ONLY);
    },
    setPrototypeOf() {
      throw misuse(READ_ONLY);
    },
    preventExtensions() {
      throw misuse(READ_ONLY);
    },
  });
}
