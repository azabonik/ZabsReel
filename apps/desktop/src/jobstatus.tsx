// The status bar line: the newest running core job (export, Render exact,
// remove background, stabilize, reframe, reverse, smooth slow motion,
// transcription, proxies...) with its percentage and a Cancel button, else the
// label of a UI action in flight, else "Ready". Job state lives here, fed by
// the core's `job` WebSocket events (seeded from list_jobs on every connect, so
// a job the AI started before the window opened shows too), so progress ticks
// re-render only this line and not the whole editor, and a job that is
// canceled or fails clears the line even though no 100% event follows.
// The logic is in jobstate.ts (checked by scripts/smoke-composite.ts).
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { CoreApi } from "./api";
import type { JobInfo } from "./types";
import { applyJobEvent, cancelJob, newestFirst, statusView } from "./jobstate";

/** The running core jobs, newest first. */
function useRunningJobs(api: CoreApi, connected: boolean): JobInfo[] {
  const [jobs, setJobs] = useState<Record<string, JobInfo>>({});
  useEffect(() => {
    api.onJob((j) => setJobs((prev) => applyJobEvent(prev, j)));
    return () => api.onJob(undefined);
  }, [api]);
  useEffect(() => {
    // A (re)connected core is the source of truth: replace whatever was shown before.
    if (!connected) {
      setJobs({});
      return;
    }
    let live = true;
    api
      .rpc<{ jobs: JobInfo[] }>("list_jobs", { activeOnly: true })
      .then((r) => { if (live) setJobs(Object.fromEntries(r.jobs.map((j) => [j.id, j]))); })
      .catch(() => {});
    return () => { live = false; };
  }, [api, connected]);
  return newestFirst(jobs);
}

export function StatusLine(props: {
  api: CoreApi;
  connected: boolean;
  busy: string | null;
  /** Called when the user cancels a job while a UI action is waiting on it (its RPC then rejects). */
  onCancelBusy: () => void;
}) {
  const { api, connected, busy } = props;
  const jobs = useRunningJobs(api, connected);
  const [canceling, setCanceling] = useState<string | null>(null);

  const cancel = (job: JobInfo) => {
    setCanceling(job.id);
    // The job event clears the line either way.
    void cancelJob(api, job, busy, props.onCancelBusy).finally(() => setCanceling(null));
  };
  const view = statusView(jobs, busy, connected);
  if (view.kind === "job") {
    const { job } = view;
    return (
      <div className="prog">
        <span className="label" title={jobs.map((j) => j.label).join("\n")}><span className="spinner" /> {view.label}…{view.more}</span>
        {view.pct !== null ? (
          <>
            <div className="prog-bar"><div className="prog-fill" style={{ "--p": job.fraction } as CSSProperties} /></div>
            <span className="pct">{view.pct}</span>
          </>
        ) : (
          <span className="spacer" />
        )}
        <button className="btn btn-ghost btn-sm" onClick={() => cancel(job)} disabled={canceling === job.id}
          title={`Stop: ${job.label}`}>
          {canceling === job.id ? "Canceling…" : "Cancel"}
        </button>
      </div>
    );
  }
  if (view.kind === "busy") return <span className="ready"><span className="spinner" /> {view.text}</span>;
  return <span className="ready">{view.text}</span>;
}
