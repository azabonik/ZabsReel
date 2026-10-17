// Help → Graphics add-on… (ADDON-PLAN D4): graphics render with Remotion, which
// the user installs as an add-on under Remotion's own licence. The dialog shows
// the notice and the licence exactly as the UI host gives them (core
// addon/terms.ts), and only its Accept button installs: the host (Electron
// main, or the web shell behind its shell key) downloads the pinned packages
// and browser. The agent can't install it; when its add_graphic is refused for
// the add-on, the core broadcasts the add-on's state and the banner below
// offers this dialog. The same dialog serves the desktop window and the web
// shell. Escape, the scrim, the X and Close call onClose; an install goes on
// in the host, and the dialog shows it again when it is opened.
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { PRODUCT_NAME } from "@aive/core/brand";
import type { CoreApi, GraphicsAddonRefusal } from "./api";
import type { GraphicsAddonStatus, GraphicsAddonTerms, JobInfo } from "./types";
import { applyJobEvent, listedJobs } from "./jobstate";
import { platform } from "./platform";
import { fmtBytes } from "./storagedialog";
import { Alert, Sparkles, X } from "./icons";
import "./storage.css";
import "./networkcomputers.css";
import "./graphicsaddon.css";

/** What the banner says for each refusal; it carries nothing from the agent. */
const BANNER: Record<GraphicsAddonRefusal, string> = {
  "not-installed": "The AI asked for a graphic. Graphics need the Remotion add-on.",
  "update-needed": `The AI asked for a graphic. The Remotion add-on must be updated for this version of ${PRODUCT_NAME}.`,
  broken: "The AI asked for a graphic. The Remotion add-on is damaged (missing files).",
  unsupported: "The AI asked for a graphic, but the graphics add-on isn't available on this computer.",
};

/** The banner above the preview after the agent's add_graphic was refused: polite status, nothing takes focus. */
export function GraphicsAddonBanner(props: { state: GraphicsAddonRefusal | null; onSetUp: () => void; onDismiss: () => void }) {
  const { state, onSetUp, onDismiss } = props;
  if (!state) return null;
  return (
    <div className="ga-banner" role="status" aria-live="polite">
      <div className="ms-line">
        <Alert size={15} />
        <span className="ms-text">{BANNER[state]}</span>
        {state !== "unsupported" && <button className="btn btn-sm" onClick={onSetUp}>Set up…</button>}
        <button className="icon-btn" onClick={onDismiss} aria-label="Hide" title="Hide"><X size={13} /></button>
      </div>
    </div>
  );
}

/**
 * Whether a graphic is rendering (a running core job of type "graphic"): Remove, Reinstall and Update wait for it.
 * The running jobs are asked for again on every (re)connect, and that answer replaces what was known (listedJobs).
 */
function useGraphicRendering(api: CoreApi, connected: boolean): boolean {
  const [jobs, setJobs] = useState<Record<string, JobInfo>>({});
  /** The job events since the pending list_jobs request was sent. */
  const since = useRef<JobInfo[] | null>(null);
  useEffect(() => api.subscribeJobs((j) => {
    since.current?.push(j);
    setJobs((prev) => applyJobEvent(prev, j));
  }), [api]);
  useEffect(() => {
    if (!connected) return;
    let live = true;
    const events: JobInfo[] = [];
    since.current = events;
    api
      .rpc<{ jobs: JobInfo[] }>("list_jobs", { activeOnly: true })
      .then((r) => { if (live) setJobs(listedJobs(r.jobs, events)); })
      .catch(() => {})
      .finally(() => { if (since.current === events) since.current = null; });
    return () => { live = false; };
  }, [api, connected]);
  return Object.values(jobs).some((j) => j.type === "graphic");
}

const mb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1e6))} MB`;

/** "16 Oct 2026". */
function day(iso: string | null): string {
  const d = new Date(iso ?? "");
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function GraphicsAddonDialog({ api, connected, onClose }: { api: CoreApi; connected: boolean; onClose: () => void }) {
  const [status, setStatus] = useState<GraphicsAddonStatus | null>(null);
  const [terms, setTerms] = useState<GraphicsAddonTerms | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  /** This dialog's own install or removal, while it runs. */
  const [running, setRunning] = useState<"install" | "remove" | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const rendering = useGraphicRendering(api, connected);
  const available = platform.graphicsAddon.available();

  const refresh = useCallback(async () => {
    try {
      const [s, t] = await Promise.all([platform.graphicsAddon.status(), platform.graphicsAddon.terms()]);
      setStatus(s);
      setTerms(t);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => { if (available) void refresh(); }, [available, refresh]);

  // Another window's lock, or a job this dialog didn't start (another tab, or the dialog was closed): follow it.
  const watching = !running && !!status && (!!status.busy || !!status.job);
  useEffect(() => {
    if (!watching) return;
    const t = setInterval(() => { void refresh(); }, 1000);
    return () => clearInterval(t);
  }, [watching, refresh]);

  // Modal for the keyboard too (as the Storage dialog): no key reaches the editor's shortcuts.
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

  const install = async () => {
    if (!terms) return;
    setError(null);
    setDone(null);
    setRunning("install");
    setProgress(null);
    try {
      const r = await platform.graphicsAddon.install(terms.sha256, setProgress);
      if (r.ok) setDone("Graphics are ready.");
      else setError(r.error ?? "The graphics add-on couldn't be installed.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(null);
      setProgress(null);
      await refresh();
    }
  };

  const remove = async () => {
    setError(null);
    setDone(null);
    setRunning("remove");
    try {
      const r = await platform.graphicsAddon.remove();
      if (r.ok) setDone("The graphics add-on was removed.");
      else setError(r.error ?? "The graphics add-on couldn't be removed.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(null);
      await refresh();
    }
  };

  const job = status?.job ?? null;
  const shown = progress ?? (job?.kind === "install" ? { done: job.done, total: job.total } : null);
  const installing = running === "install" || job?.kind === "install";
  const removing = running === "remove" || job?.kind === "remove";
  const idle = !!status && !installing && !removing && !status.busy;
  const state = status?.state;
  // An update, a reinstall or a repair shows the terms again only when they changed since they were accepted.
  const showTerms = idle && !!terms && (state === "not-installed" || ((state === "update-needed" || state === "broken" || state === "ready") && !status.licenseAccepted));
  const accept = showTerms ? "Accept and " : "";
  const replaces = state === "ready" || state === "update-needed" || state === "broken";
  const blocked = replaces && rendering;

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="exact-modal ga-modal" role="dialog" aria-modal="true" aria-labelledby="ga-title">
        <div className="exact-head">
          <span id="ga-title"><Sparkles size={15} /> Graphics add-on <span className="muted">— Remotion{status ? ` ${status.version}` : ""}</span></span>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X /></button>
        </div>
        <div className="ga-body">
          {!available && <p className="storage-note">{`Open ${PRODUCT_NAME} (the app or npm run web) to install the graphics add-on.`}</p>}
          {available && !status && !error && <p className="muted">Loading…</p>}
          {status && (
            <>
              {installing && (
                <div className="ga-progress" role="status">
                  <span>{shown && shown.total > 0 ? `Installing… ${mb(shown.done)} of ${mb(shown.total)}` : "Installing…"}</span>
                  <div className="prog-bar"><div className="prog-fill" style={{ "--p": shown && shown.total > 0 ? shown.done / shown.total : 0 } as CSSProperties} /></div>
                </div>
              )}
              {removing && <p className="muted storage-busy" role="status"><span className="spinner" /> Removing the graphics add-on…</p>}
              {!installing && !removing && status.busy && <p className="storage-note" role="status">{status.busy}</p>}
              {idle && state === "unsupported" && <p className="storage-note">{status.unsupported}</p>}
              {idle && state === "ready" && (
                <p className="storage-line">
                  <strong>Remotion {status.version} is installed</strong>
                  {status.bytes !== null ? ` (${fmtBytes(status.bytes)})` : ""}{status.installedAt ? `, ${day(status.installedAt)}` : ""}.
                </p>
              )}
              {idle && state === "update-needed" && (
                <p className="storage-line"><strong>Update the graphics add-on.</strong> This version of {PRODUCT_NAME} uses another copy of Remotion {status.version}.</p>
              )}
              {idle && state === "broken" && <p className="storage-note">The graphics add-on is damaged (missing files).</p>}
              {showTerms && terms && (
                <div className="ga-terms">
                  {terms.notice.split("\n\n").filter((p) => p.trim()).map((p) => <p key={p} className="ga-notice">{p}</p>)}
                  <pre className="ga-license" tabIndex={0} aria-label="Remotion's license">{terms.license}</pre>
                </div>
              )}
              {idle && blocked && <p className="storage-note" role="status">Wait for the graphic to finish.</p>}
            </>
          )}
          {done && <p className="storage-done" role="status">{done}</p>}
          {error && <p className="storage-error" role="alert">{error}</p>}
          <div className="storage-actions">
            {installing && <button className="btn btn-sm" onClick={() => void platform.graphicsAddon.cancel()}>Cancel</button>}
            <button className="btn btn-sm" onClick={onClose}>Close</button>
            {idle && state === "not-installed" && terms && (
              <button className="btn btn-sm btn-primary" onClick={install}>Accept and install</button>
            )}
            {idle && state === "update-needed" && terms && (
              <button className="btn btn-sm btn-primary" onClick={install} disabled={blocked}>{accept ? "Accept and update" : "Update"}</button>
            )}
            {idle && replaces && (
              <button className="btn btn-sm btn-danger" onClick={remove} disabled={blocked}>Remove</button>
            )}
            {idle && (state === "ready" || state === "broken") && terms && (
              <button className="btn btn-sm btn-primary" onClick={install} disabled={blocked}>{`${accept}${accept ? "reinstall" : "Reinstall"}`}</button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
