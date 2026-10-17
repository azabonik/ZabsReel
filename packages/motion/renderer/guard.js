// The render page's first script (MOTION-PLAN D2, D-WEBRTC, D-CSP). Before any
// other script runs it:
// - deletes the page's ways to open a connection the session cannot see or a
//   second global object: RTCPeerConnection, webkitRTCPeerConnection,
//   RTCDataChannel, WebTransport, Worker, SharedWorker and the ServiceWorker
//   entry point (navigator.serviceWorker). The IP handling policy, the dead
//   proxy and the CSP stop them too; this is the third layer. A same-origin
//   about:blank iframe (no src, which frame-src 'none' does not stop) still
//   has its own constructors: there only layers 1 and 2 and the CSP the frame
//   inherits apply (slice 1 deviation; smoke-renderer.ts R3 tries them);
// - gives Date.now, new Date(), performance.now and requestAnimationFrame's
//   timestamp the render's virtual time (frame / fps), set by loader.js for
//   each frame. document.timeline.currentTime and CSS animations still run on
//   the wall clock (the runtime's concern, slice 3).
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
  var RealDate = Date;
  // Date() and new Date() with no arguments read the virtual time; everything else is Date's own.
  function VirtualDate() {
    if (!new.target) return new RealDate(EPOCH + now).toString();
    var args = arguments.length ? Array.prototype.slice.call(arguments) : [Math.floor(EPOCH + now)];
    return Reflect.construct(RealDate, args, new.target);
  }
  Object.setPrototypeOf(VirtualDate, RealDate);
  VirtualDate.prototype = RealDate.prototype;
  Object.defineProperty(RealDate.prototype, "constructor", { value: VirtualDate, writable: true, configurable: true });
  VirtualDate.now = function () { return Math.floor(EPOCH + now); };
  g.Date = VirtualDate;
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
