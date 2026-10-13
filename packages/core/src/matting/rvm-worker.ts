import { parentPort, workerData } from "node:worker_threads";
import { runMattePipeline, type PipelineOptions } from "./rvm-pipeline.js";

/**
 * Worker-thread entry for remove_background (started by rvm.ts matteVideo):
 * runs the whole matte pipeline — ffmpeg I/O, RVM inference and the per-frame
 * pixel work — off the core's main thread, so RPCs and the UI stay responsive
 * while a clip is matted.
 *
 * Messages to the parent: ready (model loaded), pids (ffmpeg children),
 * progress, done (stats) or error. From the parent: cancel.
 */

export type WorkerToMain =
  | { type: "ready" }
  | { type: "pids"; pids: number[] }
  | { type: "progress"; fraction: number }
  | { type: "done"; stats: Awaited<ReturnType<typeof runMattePipeline>> }
  | { type: "error"; error: { name: string; message: string; command?: string; stderr?: string } };

export type MainToWorker = { type: "cancel" };

const port = parentPort;
if (port) {
  const abort = new AbortController();
  const post = (m: WorkerToMain) => port.postMessage(m);
  port.on("message", (m: MainToWorker) => {
    if (m?.type === "cancel") abort.abort();
  });
  runMattePipeline(workerData as PipelineOptions, abort.signal, {
    onReady: () => post({ type: "ready" }),
    onPids: (pids) => post({ type: "pids", pids }),
    onProgress: (fraction) => post({ type: "progress", fraction }),
  }).then(
    (stats) => post({ type: "done", stats }),
    (err: unknown) => {
      const e = err as { name?: string; message?: string; command?: unknown; stderr?: unknown };
      post({
        type: "error",
        error: {
          name: e?.name ?? "Error",
          message: e?.message ?? String(err),
          ...(typeof e?.command === "string" ? { command: e.command } : {}),
          ...(typeof e?.stderr === "string" ? { stderr: e.stderr } : {}),
        },
      });
    },
  );
}
