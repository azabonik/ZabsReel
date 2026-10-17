// The page's frame driver (MOTION-PLAN D2). The page's module (module.js)
// registers one function with zrMotion.onFrame(fn); for frame n the renderer
// main calls __zrMotionRender(n, fps), which sets the virtual clock, runs
// fn(n), waits for two animation frames so the result is painted, and reports
// frameReady(n, cues) through the preload. The main captures the frame only
// after that report.
(function () {
  "use strict";
  var g = window;
  var host = g.zrMotionHost;
  var clock = g.__zrMotionClock;
  var draw = null;

  Object.defineProperty(g, "zrMotion", {
    value: Object.freeze({
      onFrame: function (fn) { draw = fn; },
    }),
  });

  function painted() {
    return new Promise(function (resolve) {
      requestAnimationFrame(function () { requestAnimationFrame(function () { resolve(); }); });
    });
  }

  Object.defineProperty(g, "__zrMotionRender", {
    value: function (n, fps) {
      clock.setFrame(n, fps);
      Promise.resolve()
        .then(function () { return draw ? draw(n) : undefined; })
        .then(painted)
        .then(
          function () { host.frameReady(n, []); },
          function (err) {
            host.log("frame " + n + " failed: " + (err && err.message ? err.message : String(err)));
            host.frameReady(n, []);
          },
        );
    },
  });
})();
