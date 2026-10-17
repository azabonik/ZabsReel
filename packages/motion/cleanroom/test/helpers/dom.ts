// Test environment: a jsdom window as the global DOM. Import this first in every test file that
// renders (before react-dom is loaded, since react-dom checks for a DOM when it loads).

import { JSDOM, VirtualConsole } from "jsdom";

const virtualConsole = new VirtualConsole(); // jsdom's own error reports are not forwarded
const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
  url: "http://localhost/",
  virtualConsole,
});
const win = dom.window as unknown as Record<string, unknown> & Window;
const globals = globalThis as unknown as Record<string, unknown>;

globals.window = win;
globals.document = win.document;
for (const name of [
  "Node",
  "Element",
  "HTMLElement",
  "HTMLImageElement",
  "HTMLAudioElement",
  "HTMLDivElement",
  "HTMLIFrameElement",
  "Event",
  "MouseEvent",
  "Text",
  "DocumentFragment",
  "getComputedStyle",
]) {
  globals[name] = win[name];
}

// React's development build re-reports errors that an error boundary caught through a window
// "error" event; marking them handled keeps jsdom quiet. Real failures still reach the tests
// through renderFrame's rejection.
win.addEventListener("error", (event) => event.preventDefault());

const SILENCED = [
  // The page uses React's production build, which has no such warning.
  'You are importing createRoot from "react-dom"',
  // Development-build logging of errors that the runtime's error boundary caught on purpose.
  "The above error occurred in",
];

const originalError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  const text = args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ");
  if (SILENCED.some((s) => text.includes(s))) return;
  originalError(...args);
};

export const testWindow = win;
