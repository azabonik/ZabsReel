import "./helpers/dom";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { asset } from "../runtime/src/index";
import {
  FakeFontFace,
  fontAsset,
  imageAsset,
  installFontStubs,
  makeHost,
  moduleFor,
  mount,
  rejectsWithCode,
  throwsCode,
  ticks,
  track,
} from "./helpers/host";

function fontAssets(n: number) {
  const out: Record<string, ReturnType<typeof fontAsset>> = { logo: imageAsset("h-logo") };
  for (let i = 0; i < n; i++) out[`font${i}`] = fontAsset(`h-font${i}`);
  return out;
}

test("loadFont registers a FontFace with url(fontUrl(handle)), adds it to document.fonts and loads it", async () => {
  const fonts = installFontStubs();
  const host = makeHost({ assets: fontAssets(2) });
  const mod = moduleFor(host);
  const m = mount(host, () => null);
  const result = mod.loadFont(asset("font0"));
  assert.deepEqual(result, { fontFamily: "zr-font-font0" });
  assert.equal(FakeFontFace.created.length, 1);
  const face = FakeFontFace.created[0];
  assert.equal(face.family, "zr-font-font0");
  assert.equal(face.source, "url(https://fonts.test/h-font0.woff2)");
  assert.ok(fonts.faces.has(face));
  assert.equal(face.loadCalls, 1);
  // The frame waits for the face to load.
  const t = track(m.app.renderFrame(0));
  await ticks(5);
  assert.equal(t.settled(), false);
  face.finish();
  await t.promise;
  m.app.unmount();
});

test("loadFont accepts a font id string and uses options.family", async () => {
  installFontStubs();
  const host = makeHost({ assets: fontAssets(1) });
  const mod = moduleFor(host);
  const m = mount(host, () => null);
  assert.deepEqual(mod.loadFont("font0", { family: "Brand Sans" }), { fontFamily: "Brand Sans" });
  assert.equal(FakeFontFace.created[0].family, "Brand Sans");
  FakeFontFace.created[0].finish();
  await m.app.renderFrame(0);
  m.app.unmount();
});

test("calls are keyed by asset id: a repeat call returns the first name and adds no face", async () => {
  installFontStubs();
  const host = makeHost({ assets: fontAssets(1) });
  const mod = moduleFor(host);
  const m = mount(host, () => null);
  const first = mod.loadFont("font0", { family: "First" });
  const second = mod.loadFont(asset("font0"), { family: "Second" });
  assert.deepEqual(first, { fontFamily: "First" });
  assert.deepEqual(second, { fontFamily: "First" });
  assert.equal(FakeFontFace.created.length, 1);
  FakeFontFace.created[0].finish();
  await m.app.renderFrame(0);
  m.app.unmount();
});

test("recorded choice: two ids with the same family both register a face, in call order", async () => {
  const fonts = installFontStubs();
  const host = makeHost({ assets: fontAssets(2) });
  const mod = moduleFor(host);
  const m = mount(host, () => null);
  mod.loadFont("font0", { family: "Shared" });
  mod.loadFont("font1", { family: "Shared" });
  assert.deepEqual(
    [...fonts.faces].map((f) => [f.family, f.source]),
    [
      ["Shared", "url(https://fonts.test/h-font0.woff2)"],
      ["Shared", "url(https://fonts.test/h-font1.woff2)"],
    ],
  );
  for (const f of FakeFontFace.created) f.finish();
  await m.app.renderFrame(0);
  m.app.unmount();
});

test("a font that fails to load fails the frame with graphic_media_failed naming the id", async () => {
  installFontStubs();
  const host = makeHost({ assets: fontAssets(1) });
  const mod = moduleFor(host);
  const m = mount(host, () => null);
  mod.loadFont("font0");
  const pending = m.app.renderFrame(0);
  FakeFontFace.created[0].fail(new Error("corrupt"));
  const error = await rejectsWithCode(pending, "graphic_media_failed");
  assert.ok(error.message.includes('"font0"'));
  m.app.unmount();
});

test("loadFont throws graphic_asset_unknown or graphic_asset_kind, and the next renderFrame rejects with it", async () => {
  for (const [ref, code] of [
    ["nope", "graphic_asset_unknown"],
    [asset("nope"), "graphic_asset_unknown"],
    [42, "graphic_asset_unknown"],
    ["logo", "graphic_asset_kind"],
  ] as const) {
    installFontStubs();
    const host = makeHost({ assets: fontAssets(1) });
    const mod = moduleFor(host);
    const m = mount(host, () => null);
    const thrown = throwsCode(() => mod.loadFont(ref), code);
    if (code === "graphic_asset_kind") assert.ok(thrown.message.includes('"logo"'));
    else if (typeof ref === "string") assert.ok(thrown.message.includes(`"${ref}"`));
    await assert.rejects(m.app.renderFrame(0), (e) => e === thrown);
    m.app.unmount();
  }
});

test("loadFont called during a pending renderFrame rejects that frame", async () => {
  installFontStubs();
  const host = makeHost({ assets: fontAssets(1), frameTimeoutMs: 2000 });
  const mod = moduleFor(host);
  function Uses() {
    React.useEffect(() => {
      Promise.resolve().then(() => {
        try {
          mod.loadFont("missing");
        } catch {
          // swallowed by user code; the frame still rejects
        }
      });
    }, []);
    return null;
  }
  const m = mount(host, Uses);
  await rejectsWithCode(m.app.renderFrame(0), "graphic_asset_unknown");
  m.app.unmount();
});

test("at most 16 distinct font ids per app; the 17th fails with graphic_font_cap", async () => {
  installFontStubs();
  const host = makeHost({ assets: fontAssets(17) });
  const mod = moduleFor(host);
  const m = mount(host, () => null);
  for (let i = 0; i < 16; i++) mod.loadFont(`font${i}`);
  mod.loadFont("font3"); // repeats do not count
  const error = throwsCode(() => mod.loadFont("font16"), "graphic_font_cap");
  for (const f of FakeFontFace.created) f.finish();
  await assert.rejects(m.app.renderFrame(0), (e) => e === error);
  m.app.unmount();
});

test("loadFont at the top level of the module holds the first frame until the face loads", async () => {
  installFontStubs();
  const host = makeHost({ assets: fontAssets(1) });
  const mod = moduleFor(host);
  mod.loadFont("font0");
  const m = mount(host, () => null);
  const t = track(m.app.renderFrame(0));
  await ticks(5);
  assert.equal(t.settled(), false);
  FakeFontFace.created[0].finish();
  await t.promise;
  m.app.unmount();
});

test("unmount removes the app's font faces from document.fonts", async () => {
  const fonts = installFontStubs();
  const host = makeHost({ assets: fontAssets(2) });
  const mod = moduleFor(host);
  const m = mount(host, () => null);
  mod.loadFont("font0", { family: "A" });
  mod.loadFont("font1", { family: "B" });
  for (const f of FakeFontFace.created) f.finish();
  await m.app.renderFrame(0);
  assert.equal(fonts.faces.size, 2);
  m.app.unmount();
  assert.equal(fonts.faces.size, 0);
});

test("recorded choice: invalid loadFont options throw graphic_api_misuse", () => {
  installFontStubs();
  const mod = moduleFor(makeHost({ assets: fontAssets(1) }));
  throwsCode(() => mod.loadFont("font0", "Brand"), "graphic_api_misuse");
  throwsCode(() => mod.loadFont("font0", { family: "" }), "graphic_api_misuse");
  throwsCode(() => mod.loadFont("font0", { family: 7 }), "graphic_api_misuse");
});

test("recorded choice: loadFont after unmount throws graphic_render_cancelled and registers nothing", async () => {
  installFontStubs();
  const host = makeHost({ assets: fontAssets(1) });
  const mod = moduleFor(host);
  const m = mount(host, () => null);
  m.app.unmount();
  throwsCode(() => mod.loadFont("font0"), "graphic_render_cancelled");
  assert.equal(FakeFontFace.created.length, 0);
});

test("recorded choice: without FontFace support the frame fails with graphic_media_failed", async () => {
  installFontStubs();
  delete (globalThis as Record<string, unknown>).FontFace;
  const host = makeHost({ assets: fontAssets(1) });
  const mod = moduleFor(host);
  const m = mount(host, () => null);
  assert.deepEqual(mod.loadFont("font0"), { fontFamily: "zr-font-font0" });
  const error = await rejectsWithCode(m.app.renderFrame(0), "graphic_media_failed");
  assert.ok(error.message.includes('"font0"'));
  m.app.unmount();
});

test("tests that create several apps use distinct family names; each app removes only its own faces", async () => {
  const fonts = installFontStubs();
  const hostA = makeHost({ assets: fontAssets(1) });
  const hostB = makeHost({ assets: fontAssets(1) });
  const modA = moduleFor(hostA);
  const modB = moduleFor(hostB);
  const a = mount(hostA, () => null);
  const b = mount(hostB, () => null);
  modA.loadFont("font0", { family: "App A" });
  modB.loadFont("font0", { family: "App B" });
  for (const f of FakeFontFace.created) f.finish();
  await a.app.renderFrame(0);
  await b.app.renderFrame(0);
  a.app.unmount();
  assert.deepEqual([...fonts.faces].map((f) => f.family), ["App B"]);
  b.app.unmount();
  assert.equal(fonts.faces.size, 0);
});

test("a frame waiting on a font times out with a message naming the font", async () => {
  installFontStubs();
  const host = makeHost({ assets: fontAssets(1), frameTimeoutMs: 50 });
  const mod = moduleFor(host);
  const m = mount(host, () => null);
  mod.loadFont("font0");
  const error = await rejectsWithCode(m.app.renderFrame(0), "graphic_frame_timeout");
  assert.ok(error.message.includes('"font0"'));
  m.app.unmount();
});
