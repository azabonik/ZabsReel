/**
 * Regression check for the save picker's file-name rule (src/savename.ts):
 * a typed known extension is kept (and its filter selected); only a name with
 * no extension gets the active filter's extension.
 * Run: npx tsx apps/desktop/scripts/smoke-savename.ts
 */
import { resolveSaveName } from "../src/savename.js";
import { exportFilters } from "../src/platform.js";

let failed = 0;
const eq = (got: unknown, want: unknown, what: string) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${ok ? "" : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
  if (!ok) failed++;
};
const f = exportFilters("mp4");
eq(resolveSaveName("out.webm", f, 0), { name: "out.webm", filterIdx: 1 }, "out.webm stays webm, filter switches");
eq(resolveSaveName("/x/out.MOV", f, 0), { name: "/x/out.MOV", filterIdx: 2 }, "absolute .MOV kept");
eq(resolveSaveName("out", f, 0), { name: "out.mp4", filterIdx: 0 }, "no extension gets .mp4");
eq(resolveSaveName("my.clip", f, 0), { name: "my.clip.mp4", filterIdx: 0 }, "unknown extension is part of the name");
eq(resolveSaveName("out", exportFilters("webm"), 0), { name: "out.webm", filterIdx: 0 }, "webm preset default is .webm");
eq(resolveSaveName("out", exportFilters("mov"), 0), { name: "out.mov", filterIdx: 0 }, "mov preset default is .mov");
eq(exportFilters("webm").map((x) => x.extensions[0]), ["webm", "mp4", "mov"], "preset container listed first");
process.exit(failed ? 1 : 0);
