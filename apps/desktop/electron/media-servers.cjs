// The native dialogs main.cjs shows before it allows a network computer
// (@aive/core hosttrust.ts, trusthosts.ts): their wording and buttons, which
// display-only context the renderer may add, and the one flow that asks and
// saves the answer, for Review… and for a file picked in a native dialog.
// main.cjs shows the dialogs and owns the store; the rules live here.
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

/**
 * dialog.showMessageBox options: "Allow media from \\nas?" (Keep offline is the
 * default and Esc). `pickedPath`: the file the user picked in a native dialog.
 */
function allowDialog({ key, entry, userPath, pickedPath, platform }) {
  const asked = entry && entry.origins.includes("request") && entry.examples[0] ? `The AI assistant asked to open ${entry.examples[0]}.` : null;
  const first = pickedPath ? `You picked ${pickedPath}.` : userPath ? `You opened ${userPath}.` : projectUse(entry) ?? asked;
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

/**
 * Ask about network computer `key` and save the answer: the one flow behind
 * Review… (media-servers:approve, `via` "prompt") and a file picked in a
 * native dialog (`via` "picker", `picked` the path). `list` is the store as
 * main read it (readTrustedHosts), and it alone picks the dialog
 * (approvalDialogFor): "unread" shows only the info box and saves nothing;
 * "keep" (added outside ZabsReel) shows Keep / Remove; "allow" shows Allow /
 * Keep offline, or nothing for a server allowed already. Only the second
 * button (response 1) saves an approval. Remove or Esc in the Keep dialog
 * removes the entry while it is still outside. Resolves true when the server
 * is allowed. `io` is main's side: show (a native message box), pendingEntry
 * (the core's pending entry, for counts and examples), approve, revoke
 * (onlyIfOutside), recheck (recheck_offline_media) and log.
 */
async function reviewServer({ key, list, via, context, picked, platform, unc }, io) {
  const which = unc.approvalDialogFor(list, key);
  if (which === "unread") {
    await io.show(unreadBox());
    return false;
  }
  if (which === "allow" && list.approved.some((a) => a.host === key)) {
    await io.recheck(); // allowed already (another window): nothing to ask
    return true;
  }
  // The core's own count and examples; nothing the renderer sends is shown as fact.
  const entry = await io.pendingEntry(key);
  const box = which === "keep"
    ? keepDialog({ key, entry, platform })
    : allowDialog({ key, entry, userPath: userContextPath(context, key, entry, unc), pickedPath: picked ? unc.examplePath(picked) : null, platform });
  const { response } = await io.show(box);
  if (response === 1) {
    try {
      await io.approve(key, via);
    } catch (err) {
      io.log(`${which} \\\\${key}: ${err && err.message ? err.message : String(err)}`);
      await io.show(notSavedBox("Couldn't save; try again."));
      return false;
    }
    await io.recheck();
    return true;
  }
  if (which === "allow") return false; // Keep offline: nothing changes
  // Remove, or Esc: only while it is still outside (another window may have kept it meanwhile).
  let removed;
  try {
    ({ removed } = await io.revoke(key));
  } catch (err) {
    io.log(`remove \\\\${key}: ${err && err.message ? err.message : String(err)}`);
    await io.show(notSavedBox(`Couldn't remove \\\\${key}; try again.`));
    return false;
  }
  await io.recheck();
  return !removed;
}

/**
 * The network computers a native dialog's picked paths are on that need a
 * question, each once, with the first path picked there: every server that
 * is not allowed yet (Round 5: a pick never allows one silently, because a
 * Windows dialog follows a shortcut to another computer and returns that
 * path). A server already allowed, and the data folder's own server, ask
 * nothing. A path in a refused form is left to the core, which refuses it.
 */
function pickedHostsToAsk(paths, list, dataDir, unc) {
  const data = unc.classifyPath(dataDir);
  const skip = new Set(list.approved.map((a) => a.host));
  if (data.kind === "network") skip.add(data.host);
  const ask = new Map();
  for (const p of paths) {
    const c = unc.classifyPath(p);
    if (c.kind === "network" && !skip.has(c.host) && !ask.has(c.host)) ask.set(c.host, { key: c.host, path: p });
  }
  return [...ask.values()];
}

/**
 * Ask once per server about the paths a native dialog returned
 * (pickedHostsToAsk, then reviewServer with `via` "picker"; the store is read
 * again before each question). Resolves with the paths the caller may use:
 * those on a server the user kept offline are left out.
 */
async function askPicked(paths, { readList, dataDir, platform, unc }, io) {
  const kept = new Set();
  for (const { key, path } of pickedHostsToAsk(paths, readList(), dataDir, unc)) {
    if (!(await reviewServer({ key, list: readList(), via: "picker", picked: path, platform, unc }, io))) kept.add(key);
  }
  if (!kept.size) return paths;
  return paths.filter((p) => {
    const c = unc.classifyPath(p);
    return c.kind !== "network" || !kept.has(c.host);
  });
}

module.exports = { allowDialog, keepDialog, unreadBox, notSavedBox, userContextPath, reviewServer, pickedHostsToAsk, askPicked };
