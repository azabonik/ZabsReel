#!/usr/bin/env node
import { resolveDataDir } from "./datadir.js";
import { EditorEngine } from "./engine.js";
import { EditorServer } from "./server.js";
import { checkBinaries, ffmpegVersion } from "./ffmpeg/executor.js";
import { untestedFfmpegWarning } from "./ffmpeg/version.js";
import { pruneDataDir } from "./gc.js";

/**
 * Entry point for the persistent editor backend. Started by the Electron app
 * (or run standalone for headless / AI-only use). Prints the chosen port so a
 * launcher can capture it; also writes it to <dataDir>/server.json.
 */
async function main(): Promise<void> {
  // Absolute, so every path the engine stores under it (bakes, proxies) is too.
  // A spawner passes its own choice through AIVE_DATA_DIR (datadir.ts has the rule).
  const { dir: dataDir, reason } = resolveDataDir();
  console.error(`[aive-core] data dir: ${dataDir} (${reason})`);
  const port = process.env.AIVE_PORT ? Number(process.env.AIVE_PORT) : undefined;

  try {
    const bins = await checkBinaries();
    console.error(`[aive-core] ${bins.ffmpeg}`);
    const warning = untestedFfmpegWarning(await ffmpegVersion());
    if (warning) console.error(`[aive-core] ${warning}`);
  } catch {
    console.error(
      "[aive-core] WARNING: ffmpeg/ffprobe not found on PATH. Install FFmpeg or set AIVE_FFMPEG / AIVE_FFPROBE.",
    );
  }

  const engine = new EditorEngine(dataDir);
  const server = new EditorServer(engine, { port, dataDir });
  const boundPort = await server.start();

  // Trim accumulated render artifacts (previews/frames/scopes/stray WAVs) in
  // the background; budget via AIVE_CACHE_MAX_MB. Never blocks startup.
  void pruneDataDir(dataDir)
    .then((r) => {
      if (r.deletedFiles > 0)
        console.error(`[aive-core] gc: removed ${r.deletedFiles} cached files (${(r.freedBytes / 1e6).toFixed(1)} MB)`);
    })
    .catch(() => {});
  // Move unused baked/proxy files to their area's .trash/ and delete trash older
  // than AIVE_BAKED_TRASH_DAYS (storage.ts). No project is open yet, so this
  // relies on <dataDir>/projects.json and the autosaves. Never blocks startup.
  void engine.storage.cleanUp({ auto: true }).catch(() => {});

  console.error(`[aive-core] listening on http://127.0.0.1:${boundPort}`);
  // Machine-readable line for launchers that parse stdout. Includes the session
  // token (also in <dataDir>/server.json) so launchers can hand it to clients.
  console.log(JSON.stringify({ event: "ready", port: boundPort, dataDir, token: server.getToken() }));

  const shutdown = async () => {
    console.error("[aive-core] shutting down...");
    await server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[aive-core] fatal:", err);
  process.exit(1);
});
