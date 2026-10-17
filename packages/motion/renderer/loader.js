// The page's frame driver and module table (MOTION-PLAN D2, D5).
//
// Frames: the page registers one function with zrMotion.onFrame(fn) (host.js
// does it for a graphic; a hand-written test page does it itself). For frame
// n the renderer main calls __zrMotionRender(n, fps), which sets the virtual
// clock, runs fn(n), puts every CSS and Web Animation at that time (guard.js's
// syncAnimations), waits for two animation frames so the result is painted,
// and reports frameReady(n, cues) through the preload, with the audio cues of
// the FrameResult fn returned (none when it returned nothing). The main
// captures the frame only after that report. When fn throws or rejects, the
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

  function painted() {
    return new Promise(function (resolve) {
      requestAnimationFrame(function () { requestAnimationFrame(function () { resolve(); }); });
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
          clock.syncAnimations();
          return painted();
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
