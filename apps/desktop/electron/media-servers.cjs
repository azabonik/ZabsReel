// The native dialogs main.cjs shows before it allows a network computer
// (@aive/core hosttrust.ts, trusthosts.ts): their wording and buttons, and
// which display-only context the renderer may add. main.cjs owns the dialogs
// and the store writes; the rules live here.
//
// Electron-free on purpose, like save-rules.cjs.
const { PRODUCT_NAME } = require("./brand.cjs");

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "This project uses 3 files stored there, for example …", when the open project uses the server. */
function projectUse(entry) {
  if (!entry || !entry.origins.includes("project") || !entry.files) return null;
  const ex = entry.examples[0];
  return `This project uses ${plural(entry.files, "file")} stored there${ex ? `, for example ${ex}` : ""}.`;
}

/**
 * The path the renderer says the user opened, when the core agrees: `context`
 * is `{ origin: "user", path }`, the path is on server `key`, and the core's
 * pending entry lists it (sanitized as the core does) among the examples of a
 * request. Otherwise null. Display-only: it never changes what Allow does.
 */
function userContextPath(context, key, entry, unc) {
  if (!context || context.origin !== "user" || typeof context.path !== "string") return null;
  const c = unc.classifyPath(context.path);
  if (c.kind !== "network" || c.host !== key) return null;
  const shown = unc.examplePath(context.path);
  return entry && entry.origins.includes("request") && entry.examples.includes(shown) ? shown : null;
}

/** dialog.showMessageBox options: "Allow media from \\nas?" (Keep offline is the default and Esc). */
function allowDialog({ key, entry, userPath, platform }) {
  const asked = entry && entry.origins.includes("request") && entry.examples[0] ? `The AI assistant asked to open ${entry.examples[0]}.` : null;
  const first = userPath ? `You opened ${userPath}.` : projectUse(entry) ?? asked;
  const risk = platform === "win32"
    ? `When ${PRODUCT_NAME} opens them, Windows may automatically send your Windows sign-in (a scrambled copy of your password) to that computer. Allow it only if you know and trust this computer, for example your own network drive.`
    : `To open them, ${PRODUCT_NAME} connects to that computer. Allow it only if you know and trust it.`;
  const after = `Until you allow it, those clips stay offline and ${PRODUCT_NAME} does not contact that computer. You can remove it later in Project → Network computers.`;
  return {
    type: "question",
    buttons: ["Keep offline", "Allow"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: `Allow media from \\\\${key}?`,
    message: `Allow ${PRODUCT_NAME} to open files on the network computer "${key}"?`,
    detail: [first, risk, after].filter(Boolean).join("\n\n"),
  };
}

/** The Keep dialog for a server added outside ZabsReel (Remove is the default and Esc). */
function keepDialog({ key, entry, platform }) {
  const keepOnly = platform === "win32"
    ? `Keep it only if you added it yourself. When ${PRODUCT_NAME} opens files there, Windows may automatically send your Windows sign-in (a scrambled copy of your password) to that computer.`
    : `Keep it only if you added it yourself. To open files there, ${PRODUCT_NAME} connects to that computer.`;
  return {
    type: "warning",
    buttons: ["Remove", "Keep"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: `Keep \\\\${key}?`,
    message: `"${key}" was added to your allowed network computers outside ${PRODUCT_NAME}.`,
    detail: [
      `${PRODUCT_NAME} didn't add it. Something changed ${PRODUCT_NAME}'s settings file directly: you, another program, or an AI assistant that can run commands on this computer.`,
      projectUse(entry),
      keepOnly,
      `If you remove it, those files stay offline and ${PRODUCT_NAME} asks you again if a project needs them.`,
    ].filter(Boolean).join("\n\n"),
  };
}

/** The store could not be read and there is no good copy yet: no approval dialog, only this. */
function unreadBox() {
  return {
    type: "info",
    buttons: ["OK"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: "Network computers",
    message: `${PRODUCT_NAME} couldn't read its list of approved computers just now. Try again in a moment.`,
  };
}

/** A store write that did not happen (the lock stayed busy, or a file could not be read). */
function notSavedBox(message) {
  return { type: "error", buttons: ["OK"], defaultId: 0, cancelId: 0, noLink: true, title: "Network computers", message };
}

module.exports = { allowDialog, keepDialog, unreadBox, notSavedBox, userContextPath };
