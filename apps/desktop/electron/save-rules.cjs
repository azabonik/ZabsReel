// Decisions behind the native save dialogs and the unsaved-changes close guard.
// main.cjs owns the dialogs and the window; the rules live here so they can be
// tested under plain Node (scripts/smoke-savename.ts).
//
// Electron-free on purpose, like core-launcher.cjs.
const path = require("node:path");

// The native save dialog adds the chosen filter's extension on Windows and macOS,
// but not on Linux. Same rule as the web picker (src/savename.ts resolveSaveName
// with the first filter active; smoke-savename checks they agree): no extension
// gets the first filter's; an extension that one of the filters lists is kept;
// any other ("my.clip") is part of the name and gets the first filter's too.
function withExtension(filePath, filters) {
  const base = path.basename(filePath);
  const dot = base.lastIndexOf(".");
  const typed = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  if (typed && filters.some((f) => f.extensions.some((e) => e !== "*" && e.toLowerCase() === typed))) return filePath;
  const ext = filters[0].extensions.find((e) => e !== "*");
  return ext ? `${filePath}.${ext}` : filePath;
}

// The dialog confirmed overwriting the name as typed; when an extension was
// added, ask again (`confirmReplace(finalPath)`) if that file exists. Returns the
// path, or null to cancel.
function finalSavePath(filePath, filters, exists, confirmReplace) {
  const final = withExtension(filePath, filters);
  if (final === filePath || !exists(final)) return final;
  return confirmReplace(final) ? final : null;
}

/**
 * The close guard as a reducer. `state` is { pendingSaveQuit, forceQuit };
 * returns the next state and what main.cjs should do (`effect`):
 *   "close"   close the window (forceQuit is set, so the guard lets it through)
 *   "save" / "save-as"  ask the renderer to save, then wait for its report
 *   null      nothing
 * Events:
 *   { type: "close-dialog", choice: "save" | "dont-save" | "cancel", hasPath }
 *   { type: "save-as-cancelled" }   the Save As dialog was dismissed
 *   { type: "save-failed" }         the renderer could not write the project
 *   { type: "project-state", dirty } the renderer's dirty flag
 * Only a clean report that follows a Save chosen in the close dialog quits; a
 * cancelled or failed save drops that request, so a later save (the autosave
 * included) never closes the window on its own.
 */
function closeGuard(state, event) {
  const s = { ...state };
  switch (event.type) {
    case "close-dialog":
      s.pendingSaveQuit = false;
      if (event.choice === "dont-save") return { state: { ...s, forceQuit: true }, effect: "close" };
      if (event.choice !== "save") return { state: s, effect: null };
      return { state: { ...s, pendingSaveQuit: true }, effect: event.hasPath ? "save" : "save-as" };
    case "save-as-cancelled":
    case "save-failed":
      return { state: { ...s, pendingSaveQuit: false }, effect: null };
    case "project-state":
      if (s.pendingSaveQuit && !event.dirty) return { state: { pendingSaveQuit: false, forceQuit: true }, effect: "close" };
      return { state: s, effect: null };
    default:
      return { state: s, effect: null };
  }
}

module.exports = { withExtension, finalSavePath, closeGuard };
