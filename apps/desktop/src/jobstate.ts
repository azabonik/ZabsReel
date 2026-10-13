// The status line's logic without React (jobstatus.tsx renders it, App.tsx
// owns the busy action): which core jobs are running, what the line says, how
// Cancel reaches the core, and whether a failed UI action shows an error.
// Kept free of React and the DOM so scripts/smoke-composite.ts can check it.
import type { JobInfo } from "./types";

/** The running jobs after one `job` event: a running job is added or updated, any other status removes it. */
export function applyJobEvent(prev: Record<string, JobInfo>, j: JobInfo): Record<string, JobInfo> {
  if (j.status === "running") return { ...prev, [j.id]: j };
  if (!(j.id in prev)) return prev;
  const next = { ...prev };
  delete next[j.id];
  return next;
}

/** The running jobs, newest first. */
export function newestFirst(jobs: Record<string, JobInfo>): JobInfo[] {
  return Object.values(jobs).sort((a, b) => b.startedAt - a.startedAt);
}

export type StatusView =
  | { kind: "job"; job: JobInfo; label: string; more: string; pct: string | null }
  | { kind: "busy"; text: string }
  | { kind: "ready"; text: string };

/** What the status line shows: the newest running job, else the UI action in flight, else "Ready". */
export function statusView(jobs: JobInfo[], busy: string | null, connected: boolean): StatusView {
  const job = jobs[0];
  if (job) {
    const label = job.type === "export" ? "Exporting" : job.type === "preview" ? "Rendering" : job.label;
    const more = jobs.length > 1 ? ` (+${jobs.length - 1} more)` : "";
    return { kind: "job", job, label, more, pct: job.fraction > 0 ? `${Math.round(job.fraction * 100)}%` : null };
  }
  if (busy) return { kind: "busy", text: `${busy}…` };
  return {
    kind: "ready",
    text: connected ? "Ready — press Space to play · drive edits from your AI client or the controls above." : "Waiting for the editor core to connect…",
  };
}

/**
 * Cancel a job from the status line. When a UI action is waiting on it, that
 * action is told first (its RPC then rejects, and that is not an error).
 * Resolves once the core answered; {canceled:false} = it finished first.
 */
export function cancelJob(
  api: { rpc: (method: string, params: Record<string, unknown>) => Promise<unknown> },
  job: JobInfo,
  busy: string | null,
  onCancelBusy: () => void,
): Promise<void> {
  if (busy) onCancelBusy();
  return api.rpc("cancel_job", { jobId: job.id }).then(() => {}, () => {});
}

/**
 * The UI action in flight and whether the user canceled its job: a canceled
 * action's rejection is not shown as an error.
 */
export class BusyAction {
  private canceledByUser = false;
  start(): void {
    this.canceledByUser = false;
  }
  /** The user canceled the job this action waits on (status line Cancel). */
  cancel(): void {
    this.canceledByUser = true;
  }
  /** The error to show for a rejection of the action, or null after a user cancel. */
  errorFor(e: unknown): string | null {
    return this.canceledByUser ? null : e instanceof Error ? e.message : String(e);
  }
  end(): void {
    this.canceledByUser = false;
  }
}
