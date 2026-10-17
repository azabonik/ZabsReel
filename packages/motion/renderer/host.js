// The page's host adapter (MOTION-PLAN D5): between the runtime
// (zr-runtime.js, window.__zrMotionRuntime) and the graphic (module.js).
//
// module.js, which the core compiles from the graphic's TSX, is one call:
// __zrMotionGraphic(start, function (require, exports, module) { ... }) where
// `start` is the render's start data: the composition {id, width, height,
// fps, durationInFrames, props}, the assets table (asset id -> {handle, kind,
// sizes}; no path) and frameTimeoutMs. The adapter builds the runtime's
// MotionHost from it, sizes #root to the composition, evaluates the graphic
// against the module object (loader.js's require table), mounts its default
// export with createMotionApp and registers zrMotion.onFrame(n =>
// app.renderFrame(n)), so loader.js reports each frame's cues, or its error.
//
// Until module.js has called it, every frame fails: a graphic whose code did
// not run (a script error) must not render as an empty, successful graphic.
// A hand-written test page registers its own onFrame after this and is
// unaffected.
(function () {
  "use strict";
  var g = window;
  var firstError = null;
  g.addEventListener("error", function (e) {
    if (!firstError) firstError = e && e.message ? String(e.message) : "a script error";
  });
  function notRun() {
    var err = new Error("The graphic's code did not run" + (firstError ? ": " + firstError : "."));
    err.code = "graphic_component_error";
    return Promise.reject(err);
  }
  g.zrMotion.onFrame(notRun);

  /**
   * The media routes the renderer main forwards to the core (motion-renderer.cjs):
   * zrmotion://media/<handle>?query, and fonts at zrmotion://app/font/<handle>,
   * the page's own origin (a font load is a CORS request, which fails for
   * another zrmotion: host).
   */
  function mediaRoute(handle, query) {
    return "zrmotion://media/" + encodeURIComponent(handle) + "?" + query;
  }

  function hostFor(start) {
    return {
      composition: start.composition,
      assets: start.assets || {},
      frameTimeoutMs: start.frameTimeoutMs,
      mediaUrl: function (handle, box, sourceFrame) {
        var q = (sourceFrame === undefined ? "" : "t=" + sourceFrame + "&") + "w=" + box.w + "&h=" + box.h;
        return mediaRoute(handle, q);
      },
      fontUrl: function (handle) { return "zrmotion://app/font/" + encodeURIComponent(handle); },
      log: function (text) { g.zrMotionHost.log(String(text)); },
    };
  }

  Object.defineProperty(g, "__zrMotionGraphic", {
    value: function (start, body) {
      try {
        var runtime = g.__zrMotionRuntime;
        var host = hostFor(start);
        var c = host.composition;
        // BR18: the host sizes the container; the runtime fills it.
        var root = document.getElementById("root");
        root.style.position = "relative";
        root.style.overflow = "hidden";
        root.style.width = c.width + "px";
        root.style.height = c.height + "px";
        var mod = runtime.createModuleObject(host);
        var module = { exports: {} };
        body(g.zrMotion.require(mod), module.exports, module);
        var component = module.exports && module.exports.default;
        if (typeof component !== "function" && !(component && typeof component === "object")) {
          var err = new Error("The graphic's code must default-export a React component (export default function Graphic() { ... }).");
          err.code = "graphic_api_misuse";
          throw err;
        }
        var app = runtime.createMotionApp(host, component, root);
        g.zrMotion.onFrame(function (n) { return app.renderFrame(n); });
      } catch (err) {
        g.zrMotion.onFrame(function () { return Promise.reject(err); });
      }
    },
  });
})();
