// The render page's first script (MOTION-PLAN D2, D-WEBRTC, D-CSP). Before any
// other script runs it:
// - deletes the page's ways to open a connection the session cannot see or a
//   second global object: RTCPeerConnection, webkitRTCPeerConnection,
//   RTCDataChannel, WebTransport, Worker, SharedWorker and the ServiceWorker
//   entry point (navigator.serviceWorker). The IP handling policy, the dead
//   proxy and the CSP stop them too; this is the third layer;
// - gives Date.now, performance.now and requestAnimationFrame's timestamp the
//   render's virtual time (frame / fps), set by loader.js for each frame.
(function () {
  "use strict";
  var g = window;
  var names = [
    "RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "WebTransport",
    "Worker", "SharedWorker", "ServiceWorker", "ServiceWorkerContainer", "ServiceWorkerRegistration",
  ];
  for (var i = 0; i < names.length; i++) delete g[names[i]];
  delete Navigator.prototype.serviceWorker;

  // 2000-01-01T00:00:00Z at frame 0, the same on every render.
  var EPOCH = 946684800000;
  var now = 0;
  var raf = g.requestAnimationFrame.bind(g);
  Date.now = function () { return EPOCH + now; };
  g.performance.now = function () { return now; };
  g.requestAnimationFrame = function (cb) {
    return raf(function () { cb(now); });
  };
  Object.defineProperty(g, "__zrMotionClock", {
    value: Object.freeze({
      setFrame: function (n, fps) { now = (n * 1000) / fps; },
    }),
  });
})();
