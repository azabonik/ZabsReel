// Project menu → "Storage…": disk usage of the data dir and the baked/ +
// proxies/ clean-up (core storage.ts). Reads storage_report (a dry run) and
// runs clean_up_storage. The scrim and the panel render together from the one
// `open` flag in App, and Escape, the scrim, the X and Close all call onClose,
// so no overlay can stay behind. "Empty trash" confirms inline, not with
// window.confirm. The dialog is modal for the keyboard too: no key reaches the
// editor's shortcuts while it is open.
import { useCallback, useEffect, useState } from "react";
import type { CoreApi } from "./api";
import { Trash, X } from "./icons";
import "./storage.css";

interface StorageReport {
  usage: Record<string, { bytes: number; size: string; files: number }>;
  totalBytes: number;
  wouldTrashCount: number;
  wouldTrashBytes: number;
  /** Of the unused files: made before ZabsReel began tracking project files. */
  predatesTracking: { count: number; bytes: number };
  gracePeriod: { count: number; bytes: number };
  trashCount: number;
  trashBytes: number;
  /** Trashed files a project names again (the next clean-up moves them back). */
  inUseTrash: { count: number; bytes: number };
  /** What Empty trash would delete for good. */
  emptyTrash: { count: number; bytes: number };
  unavailableProjects: { path: string; pausesCleanUp: boolean }[];
  blockedBy: string | null;
  /** Other running ZabsReel cores on this data folder (their undo history counts too). */
  otherCores: number;
  /** Bakes the open project's library holds that no clip uses. */
  libraryBakes: { count: number; bytes: number };
  settings: { gracePeriodMinutes: number; trashDays: number };
  warnings: string[];
}

interface CleanupResult {
  skipped?: string;
  moved: unknown[];
  movedBytes: number;
  restored: unknown[];
  purged: unknown[];
  freedBytes: number;
  keptInTrash: unknown[];
  forgotProjects: string[];
  failed: { name: string; error: string }[];
}

const AREAS: [key: string, label: string][] = [
  ["baked", "Bakes (cutouts, stabilize, reverse, slow motion…)"],
  ["proxies", "Preview proxies"],
  ["trash", "Trash"],
  ["cache", "Render cache"],
  ["previews", "Previews"],
  ["frames", "Frames"],
  ["masks", "Masks"],
  ["other", "Other"],
];

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function StorageDialog({ api, onClose }: { api: CoreApi; onClose: () => void }) {
  const [report, setReport] = useState<StorageReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; warn: boolean } | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setReport(await api.rpc<StorageReport>("storage_report"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);
  useEffect(() => { void refresh(); }, [refresh]);

  // Capture phase on window, ahead of the editor's shortcuts: no key reaches
  // them while the dialog is open (Delete would remove the selected clip
  // behind it, Space would play). Default actions still happen: Tab moves
  // focus, Enter/Space press the focused button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const clean = async (opts: { emptyTrash?: boolean; forgetMissing?: boolean } = {}) => {
    setConfirmEmpty(false);
    setNote(null);
    setBusy(opts.emptyTrash ? "Emptying the trash…" : "Cleaning up…");
    try {
      const r = await api.rpc<CleanupResult>("clean_up_storage", opts);
      if (r.skipped) setNote({ text: r.skipped, warn: true });
      else {
        const days = report?.settings.trashDays ?? 7;
        const parts: string[] = [];
        if (r.forgotProjects.length) parts.push(`Forgot ${plural(r.forgotProjects.length, "missing project file")}.`);
        if (r.restored.length) parts.push(`Moved ${plural(r.restored.length, "file")} a project still uses back out of the trash.`);
        parts.push(`Moved ${plural(r.moved.length, "file")} (${fmtBytes(r.movedBytes)}) to the trash.`);
        if (r.purged.length) parts.push(`Deleted ${plural(r.purged.length, "item")}, freed ${fmtBytes(r.freedBytes)}.`);
        if (r.keptInTrash.length) parts.push(`Kept ${plural(r.keptInTrash.length, "older file")} in the trash for ${plural(days, "day")}.`);
        if (r.failed.length) parts.push(`${plural(r.failed.length, "file")} could not be moved (in use?) — try again later.`);
        setNote({ text: parts.join(" "), warn: r.failed.length > 0 });
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const removeLibraryBakes = async () => {
    setNote(null);
    setBusy("Removing unused bakes from the library…");
    try {
      const r = await api.rpc<{ removed: unknown[] }>("remove_unused_media", {});
      setNote({ text: `Removed ${plural(r.removed.length, "unused item")} from the library (Undo brings them back). Clean up now moves the files to the trash once nothing uses them.`, warn: false });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const blocked = !!report?.blockedBy;
  const paused = report ? report.unavailableProjects.filter((u) => u.pausesCleanUp).length : 0;
  const older = report?.predatesTracking ?? { count: 0, bytes: 0 };
  const newerUnused = report ? report.wouldTrashCount - older.count : 0;

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="exact-modal storage-modal" role="dialog" aria-modal="true" aria-labelledby="storage-title">
        <div className="exact-head">
          <span id="storage-title"><Trash size={15} /> Storage <span className="muted">— ZabsReel's data folder</span></span>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X /></button>
        </div>
        <div className="storage-body">
          {!report && !error && <p className="muted">Measuring…</p>}
          {report && (
            <>
              <table className="storage-table">
                <tbody>
                  {AREAS.map(([key, label]) => (
                    <tr key={key}>
                      <td>{label}</td>
                      <td className="storage-size">{fmtBytes(report.usage[key]?.bytes ?? 0)}</td>
                    </tr>
                  ))}
                  <tr className="storage-total">
                    <td>Total</td>
                    <td className="storage-size">{fmtBytes(report.totalBytes)}</td>
                  </tr>
                </tbody>
              </table>
              <p className="storage-line">
                <strong>Unused files: {report.wouldTrashCount} ({fmtBytes(report.wouldTrashBytes)})</strong> — Clean up now moves them to the trash.
                {older.count > 0 && (
                  <span className="muted">
                    {" "}{older.count === report.wouldTrashCount ? (older.count === 1 ? "It was" : "All of them were") : `${older.count} of them (${fmtBytes(older.bytes)}) ${older.count === 1 ? "was" : "were"}`} made
                    {" "}before ZabsReel began tracking project files, so an older project you haven't opened since may still use {older.count === 1 ? "it" : "them"}.
                    {" "}Automatic clean-ups leave {older.count === 1 ? "it" : "these"} alone; opening that project within {plural(report.settings.trashDays, "day")} of a clean-up brings {older.count === 1 ? "it" : "them"} back.
                  </span>
                )}
                {report.gracePeriod.count > 0 && (
                  <span className="muted"> {plural(report.gracePeriod.count, "newer file")} ({fmtBytes(report.gracePeriod.bytes)}) wait {report.settings.gracePeriodMinutes} min first.</span>
                )}
              </p>
              {(report.libraryBakes?.count ?? 0) > 0 && (
                <p className="storage-line">
                  <strong>Bakes only the library holds: {report.libraryBakes.count} ({fmtBytes(report.libraryBakes.bytes)})</strong> — no clip in
                  {" "}this project uses {report.libraryBakes.count === 1 ? "it" : "them"}, so {report.libraryBakes.count === 1 ? "its file stays" : "their files stay"}.
                  <span className="muted"> {report.libraryBakes.count === 1 ? "It leaves" : "They leave"} the library by
                  {" "}{report.libraryBakes.count === 1 ? "itself" : "themselves"} once undo can't bring the clip back.</span>
                  {" "}<button className="btn btn-sm" onClick={removeLibraryBakes} disabled={!!busy}>Remove from library</button>
                </p>
              )}
              {report.otherCores > 0 && (
                <p className="storage-line muted">
                  {report.otherCores === 1 ? "Another ZabsReel core uses" : `${report.otherCores} other ZabsReel cores use`} this data folder
                  {" "}(an AI client's, for example); files {report.otherCores === 1 ? "its" : "their"} project and undo history use are kept too.
                </p>
              )}
              <p className="storage-line">
                <strong>Trash: {fmtBytes(report.trashBytes)}</strong> (emptied automatically after {report.settings.trashDays} days).
                <span className="muted"> Opening a project brings back any trashed file it uses.</span>
                {report.inUseTrash.count > 0 && (
                  <span className="muted"> {plural(report.inUseTrash.count, "trashed file")} that a project still uses {report.inUseTrash.count === 1 ? "goes" : "go"} back at the next clean-up.</span>
                )}
              </p>
              {report.blockedBy && <p className="storage-note">{report.blockedBy}.</p>}
              {report.warnings.map((w) => <p key={w} className="storage-note">{w}</p>)}
              {paused > 0 && !confirmEmpty && (
                <div className="storage-actions storage-paused">
                  <button className="btn btn-sm" onClick={() => clean({ forgetMissing: true })} disabled={!!busy || blocked}>
                    Forget {paused === 1 ? "this project file" : "these project files"} and clean up
                  </button>
                </div>
              )}
            </>
          )}
          {note && <p className={note.warn ? "storage-note" : "storage-done"} role="status">{note.text}</p>}
          {error && <p className="storage-error" role="alert">{error}</p>}

          {confirmEmpty ? (
            <div className="storage-confirm" role="group" aria-label="Confirm empty trash">
              <span>
                Delete {fmtBytes(report?.emptyTrash.bytes ?? 0)} for good?
                {newerUnused > 0 && ` This includes the ${plural(newerUnused, "unused file")} not in the trash yet.`}
                {older.count > 0 && (older.count === 1 ? " The older file made before project tracking goes to the trash instead and stays" : ` The ${older.count} older files made before project tracking go to the trash instead and stay`)}
                {older.count > 0 && ` there for ${plural(report?.settings.trashDays ?? 7, "day")}.`}
                {" "}A project that still uses the deleted files can't get them back.
              </span>
              <div className="storage-actions">
                <button className="btn btn-sm" onClick={() => setConfirmEmpty(false)} autoFocus>Cancel</button>
                <button className="btn btn-sm btn-danger" onClick={() => clean({ emptyTrash: true })}>Delete for good</button>
              </div>
            </div>
          ) : (
            <div className="storage-actions">
              {busy && <span className="muted storage-busy"><span className="spinner" /> {busy}</span>}
              <button className="btn btn-sm" onClick={onClose}>Close</button>
              <button className="btn btn-sm btn-danger" onClick={() => setConfirmEmpty(true)} disabled={!report || !!busy || blocked || report.emptyTrash.count === 0}>
                Empty trash
              </button>
              <button className="btn btn-sm btn-primary" onClick={() => clean()} disabled={!report || !!busy || blocked}>
                Clean up now
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
