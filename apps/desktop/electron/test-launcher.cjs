// Verifies the shared-session behavior of core-launcher.cjs:
//   - When a core is already running (e.g. spawned by the MCP server for the
//     AI), opening the app ATTACHES to it (owned=false) instead of spawning a
//     second one — so the user sees the AI's live timeline.
//   - When no core is running, the app spawns its own (owned=true).
//   - The attach case of the network-computer approvals: a UI host approves a
//     server by writing <dataDir>/trust (approveHost), which the attached core
//     (spawned by someone else, nothing handed over at spawn) picks up. An
//     entry written there by hand is listed as "outside", never approved, until
//     the UI host keeps it.
// AIVE_TEST_PORT / AIVE_TEST_PORT2 pick the two cores' ports (default 4931 and
// the core's own default).
const { startCore, ensureCore } = require("./core-launcher.cjs");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aive-launch-"));
  process.env.AIVE_DATA_DIR = dir;
  console.log("dataDir:", dir);

  // An entry written by hand (no stamp), as a shell agent would, before the core starts.
  fs.mkdirSync(path.join(dir, "trust"), { recursive: true });
  fs.writeFileSync(path.join(dir, "trust", "hosts.json"), JSON.stringify({ version: 2, servers: [{ host: "zr-evil-3.invalid" }] }));

  // 1. Simulate an existing core (as if the MCP server started it for the AI).
  process.env.AIVE_PORT = process.env.AIVE_TEST_PORT || "4931";
  const existing = await startCore(dir, process.execPath);
  console.log(`1. existing core running on port ${existing.port}`);

  // 2. App opens -> must ATTACH, not spawn.
  const attached = await ensureCore(process.execPath);
  console.log(`2. ensureCore -> ${attached.owned ? "SPAWNED (BAD)" : "attached (good)"} port ${attached.port}`);
  if (attached.owned) throw new Error("expected to ATTACH to the existing core, but spawned a new one");
  if (attached.port !== existing.port) throw new Error(`attached to wrong port ${attached.port}`);

  // 2b. Approvals reach the attached core through the trust folder, with its token alone.
  const rpc = async (method) => {
    const res = await fetch(`http://127.0.0.1:${attached.port}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-aive-token": attached.token },
      body: JSON.stringify({ method, params: {} }),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(`${method}: ${json.error}`);
    return json.result;
  };
  const hosts = (xs) => xs.map((x) => x.host).sort().join(",");
  let servers = await rpc("list_media_servers");
  console.log(`2b. attached core: approved [${hosts(servers.approved)}], outside [${hosts(servers.outside)}]`);
  if (servers.approved.length !== 0 || hosts(servers.outside) !== "zr-evil-3.invalid") throw new Error("the hand-written entry must be outside, not approved");
  const { approveHost } = await import("@aive/core/trusthosts");
  await approveHost(dir, "zr-evil-1.invalid", "prompt"); // Allow
  await approveHost(dir, "zr-evil-3.invalid", "prompt"); // Keep
  await rpc("recheck_offline_media");
  servers = await rpc("list_media_servers");
  console.log(`    after Allow + Keep: approved [${hosts(servers.approved)}], outside [${hosts(servers.outside)}]`);
  if (hosts(servers.approved) !== "zr-evil-1.invalid,zr-evil-3.invalid" || servers.outside.length !== 0) throw new Error("the attached core must list both servers as approved");

  // 3. Existing core goes away; app opens again -> must spawn its own.
  existing.child.kill();
  // Let the new spawn use the default port (or AIVE_TEST_PORT2).
  if (process.env.AIVE_TEST_PORT2) process.env.AIVE_PORT = process.env.AIVE_TEST_PORT2;
  else delete process.env.AIVE_PORT;
  await sleep(1500);
  const spawned = await ensureCore(process.execPath);
  console.log(`3. ensureCore -> ${spawned.owned ? "spawned (good)" : "attached (BAD)"} port ${spawned.port}`);
  if (!spawned.owned) throw new Error("expected to SPAWN a new core, but attached");
  spawned.child.kill();

  console.log("\nLAUNCHER SHARED-SESSION TEST PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("LAUNCHER TEST FAILED:", e);
  process.exit(1);
});
