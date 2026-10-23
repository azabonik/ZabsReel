/**
 * A second process for smoke-unc rows 3 and 12: it reads or writes one
 * approval store (trusthosts.ts) while the smoke, or another child, does the
 * same, so the lock file and the atomic rename are tested across processes.
 * It prints one JSON line with its result and exits 0 (1 on an error).
 *
 *   reader <hosts.json> <stop-file> [pause-ms]  read and parse until stop-file exists (it writes
 *                                               <stop-file>.ready after its first read), pausing
 *                                               pause-ms between reads: { reads, bad }
 *   soak <dataDir> <prefix> <rounds>            approve <prefix>-i, revoke it again when i is odd
 *   first <baseDir> <name> <other> <rounds>     per round, wait for the other child at a barrier,
 *                                               then approve <name> in a fresh <baseDir>/fw-<i>
 *   stale <dataDir> <name> <barrierDir>         take the lock while a stale one is there; A goes
 *                                               first, B only once A is inside: { overlap }
 *   revoke <dataDir> <host>                     revoke <host> once (another UI host's Remove): { removed }
 *
 * Not a smoke on its own (smoke-unc.ts starts it).
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approveHost, revokeHost, withTrustLock } from "../src/trusthosts.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (path: string) => {
  while (!existsSync(path)) await sleep(1);
};

async function run(mode: string, args: string[]): Promise<unknown> {
  if (mode === "reader") {
    const [list, stop, pause] = args;
    const gap = new Int32Array(new SharedArrayBuffer(4));
    let reads = 0;
    let bad = 0;
    while (!existsSync(stop)) {
      reads++;
      try {
        JSON.parse(readFileSync(list, "utf8"));
      } catch {
        bad++;
      }
      if (reads === 1) writeFileSync(`${stop}.ready`, "");
      if (Number(pause) > 0) Atomics.wait(gap, 0, 0, Number(pause));
    }
    return { reads, bad };
  }
  if (mode === "soak") {
    const [dataDir, prefix, rounds] = args;
    for (let i = 0; i < Number(rounds); i++) {
      await approveHost(dataDir, `${prefix}-${i}`, "prompt");
      if (i % 2 === 1) await revokeHost(dataDir, `${prefix}-${i}`);
    }
    return { ok: true };
  }
  if (mode === "first") {
    const [base, name, other, rounds] = args;
    for (let i = 0; i < Number(rounds); i++) {
      writeFileSync(join(base, `ready-${i}-${name}`), "");
      await until(join(base, `ready-${i}-${other}`));
      await approveHost(join(base, `fw-${i}`), name, "prompt");
    }
    return { ok: true };
  }
  if (mode === "stale") {
    const [dataDir, name, barrier] = args;
    let overlap = false;
    await withTrustLock(
      dataDir,
      async () => {
        const counter = join(barrier, "counter");
        try {
          writeFileSync(counter, name, { flag: "wx" });
        } catch {
          overlap = true; // the other child is inside too
        }
        writeFileSync(join(barrier, `inside-${name}`), "");
        await sleep(100);
        if (!overlap) unlinkSync(counter);
      },
      {
        onStale: async () => {
          writeFileSync(join(barrier, `judged-${name}`), "");
          await until(join(barrier, "judged-A"));
          await until(join(barrier, "judged-B"));
          if (name === "B") await until(join(barrier, "inside-A"));
        },
      },
    );
    return { overlap };
  }
  if (mode === "revoke") {
    const [dataDir, host] = args;
    return { removed: (await revokeHost(dataDir, host)).removed };
  }
  throw new Error(`unknown mode ${mode}`);
}

run(process.argv[2], process.argv.slice(3)).then(
  (r) => {
    console.log(JSON.stringify(r));
    process.exit(0);
  },
  (err) => {
    console.log(JSON.stringify({ error: (err as Error).message }));
    process.exit(1);
  },
);
