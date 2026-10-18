// The page's frame driver and module table (MOTION-PLAN D2, D5).
//
// Frames: the page registers one function with zrMotion.onFrame(fn) (host.js
// does it for a graphic; a hand-written test page does it itself). For frame
// n the renderer main calls __zrMotionRender(n, fps), which sets the virtual
// clock, runs fn(n), puts every CSS and Web Animation on a DocumentTimeline
// at that time (guard.js's syncAnimations), waits until every loaded <img> in
// the document is decoded (decoded() below), then for two animation frames so
// the result is painted, syncing again in the second one's callbacks for
// animations the graphic started in its own rAF callbacks, and reports
// frameReady(n, cues) through the preload, with the audio cues of the
// FrameResult fn returned (none when it returned nothing). The main
// captures the frame only after that report. When fn throws or rejects, or
// syncAnimations throws (an endless animation played backwards), the
// frame is not reported ready: frameFailed(n, code, message) carries the
// error's code ("" when it has none) and message, and the render fails.
//
// Modules: zrMotion.require(moduleObject) gives the graphic its require. It
// knows react (window.React), react-dom (window.ReactDOM), react/jsx-runtime
// and react/jsx-dev-runtime (one small shim over React.createElement), and
// remotion and @aive/motion (both the module object the runtime made for this
// render). Any other name throws graphic_api_unsupported.
(function () {
  "use strict";
  var g = window;
  var host = g.zrMotionHost;
  var clock = g.__zrMotionClock;
  var draw = null;

  // The automatic JSX runtime's calls, over createElement: `key` comes as its own argument.
  function jsx(type, props, key) {
    if (key === undefined) return g.React.createElement(type, props);
    var config = {};
    for (var k in props) if (Object.prototype.hasOwnProperty.call(props, k)) config[k] = props[k];
    config.key = key;
    return g.React.createElement(type, config);
  }
  var jsxRuntime = Object.freeze({
    jsx: jsx,
    jsxs: jsx,
    jsxDEV: function (type, props, key) { return jsx(type, props, key); },
    Fragment: g.React ? g.React.Fragment : undefined,
  });

  function makeRequire(moduleObject) {
    return function require(name) {
      switch (name) {
        case "react": return g.React;
        case "react-dom": return g.ReactDOM;
        case "react/jsx-runtime":
        case "react/jsx-dev-runtime": return jsxRuntime;
        case "remotion":
        case "@aive/motion": return moduleObject;
      }
      var err = new Error(
        "A graphic can import only react, react/jsx-runtime, remotion and @aive/motion, not " + JSON.stringify(String(name)) +
          ". Write the code in the graphic itself and pass data in as props.",
      );
      err.code = "graphic_api_unsupported";
      throw err;
    };
  }

  Object.defineProperty(g, "zrMotion", {
    value: Object.freeze({
      onFrame: function (fn) { draw = fn; },
      require: makeRequire,
    }),
  });

  // ZR-MEDIA-SETTLE: every loaded <img> decoded before the animation frames. img.decode() resolves
  // once the compositor holds the decoded bitmap, so the frame the main captures has it: without
  // this, a render's first frame of a 1080p video came out blank or half drawn about 2 times in
  // 100 under load, whatever the renderer main's compositor switches (motion-renderer.cjs). Only
  // loaded images: one with no source, still loading or broken shows nothing new, and its load is
  // the runtime's business. A loaded image that cannot be decoded fails the frame, as a failed
  // load does.
  function decoded() {
    var images = Array.prototype.filter.call(document.images, function (img) {
      return img.complete && img.naturalWidth > 0;
    });
    return Promise.all(images.map(function (img) {
      return img.decode().catch(function () {
        var err = new Error("An image of the graphic could not be decoded (" + text(img.getAttribute("src")).slice(0, 200) + ").");
        err.code = "graphic_media_failed";
        throw err;
      });
    }));
  }

  // Two animation frames, then the animations started since the first sync go to the frame's time too.
  function painted() {
    return new Promise(function (resolve, reject) {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          try {
            clock.syncAnimations();
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      });
    });
  }

  function text(v) {
    try { return String(v); } catch (e) { return "(a value that has no text)"; }
  }

  Object.defineProperty(g, "__zrMotionRender", {
    value: function (n, fps) {
      clock.setFrame(n, fps);
      var cues = [];
      Promise.resolve()
        .then(function () { return draw ? draw(n) : undefined; })
        .then(function (result) {
          if (result && Array.isArray(result.cues)) cues = result.cues;
          // At once, while every animation the draw started is still current.
          clock.syncAnimations();
          return decoded().then(painted);
        })
        .then(
          function () { host.frameReady(n, cues); },
          function (err) {
            var code = err && typeof err.code === "string" ? err.code : "";
            var message = err && typeof err.message === "string" ? err.message : text(err);
            host.frameFailed(n, code, message);
          },
        );
    },
  });
})();
