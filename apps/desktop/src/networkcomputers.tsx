// The network-computer UI (mediaservers.ts has the wording): the banner
// above the preview and the Project → Network computers dialog.
import { useEffect } from "react";
import { PRODUCT_NAME } from "@aive/core/brand";
import type { MediaServers, Project } from "./types";
import { BARE_LINE, UNREAD_LINE, bannerLines, plural, show } from "./mediaservers";
import { Alert, X } from "./icons";
import "./storage.css";
import "./networkcomputers.css";

/** At most this many lines, then "and N more". */
const MAX_LINES = 2;

/** The banner above the preview: polite status, real buttons, nothing takes focus. */
export function MediaServerBanner(props: {
  ms: MediaServers | null;
  project: Project | null;
  own: ReadonlySet<string>;
  dismissed: ReadonlySet<string>;
  canReview: boolean;
  onReview: (host: string) => void;
  onRetry: () => void;
  onDismiss: (host: string) => void;
}) {
  const { ms, project, own, dismissed, canReview, onReview, onRetry, onDismiss } = props;
  if (!ms) return null;
  if (ms.unread.length) {
    const waiting = ms.pending.length > 0 || !!project?.assets.some((a) => a.awaitingServer);
    return waiting ? (
      <div className="ms-banner" role="status" aria-live="polite">
        <div className="ms-line"><Alert size={15} /><span className="ms-text">{UNREAD_LINE}</span></div>
      </div>
    ) : null;
  }
  const lines = bannerLines(ms, project, own, dismissed);
  if (!lines.length) return null;
  const more = lines.length - MAX_LINES;
  return (
    <div className="ms-banner" role="status" aria-live="polite">
      {lines.slice(0, MAX_LINES).map((l) => (
        <div className="ms-line" key={l.key}>
          <Alert size={15} />
          <span className="ms-text">
            {l.before}<b>{l.who}</b>{l.after}
            {l.action === "review" && !canReview && <> {BARE_LINE}</>}
          </span>
          {l.action === "review" && canReview && l.host && (
            <button className="btn btn-sm" onClick={() => onReview(l.host!)} aria-label={`Review ${l.who}…`}>Review…</button>
          )}
          {l.action === "retry" && <button className="btn btn-sm" onClick={onRetry}>Try again</button>}
          {l.host && (
            <button className="icon-btn" onClick={() => onDismiss(l.host!)} aria-label={`Keep ${l.who} offline`} title="Keep offline (hide until the next project is opened)">
              <X size={13} />
            </button>
          )}
        </div>
      ))}
      {more > 0 && <div className="ms-more">and {more} more</div>}
    </div>
  );
}

/** "14 Oct 2026". */
function day(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "an unknown date" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * Project → Network computers…: allowed servers (Remove), servers added
 * outside ZedMix (Keep… opens the UI host's Keep dialog; Remove), and
 * servers waiting for the user (Review…). The list itself never allows one.
 */
export function NetworkComputersDialog(props: {
  ms: MediaServers | null;
  canReview: boolean;
  busy: string | null;
  error: string | null;
  onReview: (host: string) => void;
  onRemove: (host: string) => void;
  onClose: () => void;
}) {
  const { ms, canReview, busy, error, onReview, onRemove, onClose } = props;

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

  const outside = new Set(ms?.outside.map((o) => o.host));
  const waiting = ms?.pending.filter((p) => !outside.has(p.host)) ?? [];
  const head = (
    <thead>
      <tr><th scope="col">Computer</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr>
    </thead>
  );
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="exact-modal ms-modal" role="dialog" aria-modal="true" aria-labelledby="ms-title">
        <div className="exact-head">
          <span id="ms-title">Network computers <span className="muted">— where {PRODUCT_NAME} may open files</span></span>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X /></button>
        </div>
        <div className="ms-body">
          {!ms && <p className="muted">Loading…</p>}
          {ms && ms.unread.length > 0 && <p className="ms-note">{UNREAD_LINE}</p>}
          {ms && ms.unread.length === 0 && (
            <>
              <table className="ms-table">
                <caption>Allowed</caption>
                {head}
                <tbody>
                  {ms.approved.map((a) => (
                    <tr key={a.host}>
                      <th scope="row">{a.display}</th>
                      <td>Added by you on {day(a.added)} · {a.via === "picker" ? "You picked a file there" : "You allowed it"}</td>
                      <td className="ms-actions">
                        {canReview && <button className="btn btn-sm" onClick={() => onRemove(a.host)} disabled={!!busy} aria-label={`Remove ${a.display}`}>Remove</button>}
                      </td>
                    </tr>
                  ))}
                  {ms.dataFolderHost && (
                    <tr>
                      <th scope="row">{show(ms.dataFolderHost)}</th>
                      <td>{PRODUCT_NAME}'s data folder is there</td>
                      <td />
                    </tr>
                  )}
                  {ms.approved.length === 0 && !ms.dataFolderHost && (
                    <tr><td colSpan={3} className="muted">None yet. A computer you allow is listed here.</td></tr>
                  )}
                </tbody>
              </table>
              {ms.outside.length > 0 && (
                <table className="ms-table">
                  <caption>Added outside {PRODUCT_NAME}</caption>
                  {head}
                  <tbody>
                    {ms.outside.map((o) => (
                      <tr key={o.host}>
                        <th scope="row">{o.display}</th>
                        <td>{ms.gate === "enforce" ? `${PRODUCT_NAME} didn't add this, so it doesn't use it.` : `${PRODUCT_NAME} didn't add this.`}</td>
                        <td className="ms-actions">
                          {canReview && (
                            <>
                              <button className="btn btn-sm" onClick={() => onReview(o.host)} disabled={!!busy} aria-label={`Keep ${o.display}…`}>Keep…</button>
                              <button className="btn btn-sm" onClick={() => onRemove(o.host)} disabled={!!busy} aria-label={`Remove ${o.display}`}>Remove</button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {waiting.length > 0 && (
                <table className="ms-table">
                  <caption>Waiting for you</caption>
                  {head}
                  <tbody>
                    {waiting.map((p) => (
                      <tr key={p.host}>
                        <th scope="row">{p.display}</th>
                        <td>{p.origins.includes("project") && p.files > 0 ? `This project uses ${plural(p.files, "file")} there` : `A file there was asked for: ${p.examples[0] ?? ""}`}</td>
                        <td className="ms-actions">
                          {canReview && <button className="btn btn-sm" onClick={() => onReview(p.host)} disabled={!!busy} aria-label={`Review ${p.display}…`}>Review…</button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {!canReview && <p className="ms-note">{BARE_LINE}</p>}
            </>
          )}
          {error && <p className="storage-error" role="alert">{error}</p>}
          <div className="storage-actions">
            {busy && <span className="muted storage-busy"><span className="spinner" /> {busy}</span>}
            <button className="btn btn-sm" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </>
  );
}
