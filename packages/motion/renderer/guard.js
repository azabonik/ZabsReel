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
// - gives Date.now, new Date(), performance.now, requestAnimationFrame's
//   timestamp and document.timeline.currentTime the render's virtual time
//   (frame / fps), set by loader.js for each frame; a DocumentTimeline the
//   graphic makes reads that time less its originTime;
// - puts CSS animations and transitions and Web Animations on that time:
//   loader.js calls syncAnimations() once the frame is drawn and again in the
//   second animation frame's callbacks (for animations the graphic starts in
//   its own rAF callbacks), before capture. It pauses every animation on a
//   DocumentTimeline (document.timeline or one the graphic made) and sets its
//   currentTime as if it had played from time 0 at its playback rate. So
//   frame n shows the same thing whichever frames came before it (a
//   transition still starts from the previous frame's style). Animations with
//   no timeline or on a progress-based one (scroll() or view()) are left
//   alone: their progress does not depend on time, and their currentTime
//   cannot be set in milliseconds.
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
  // Any DocumentTimeline: its real time less document.timeline's real time is
  // minus its originTime (0 for document.timeline).
  var DocTimeline = g.DocumentTimeline;
  var realTime = Object.getOwnPropertyDescriptor(AnimationTimeline.prototype, "currentTime").get;
  var docTimeline = document.timeline;
  Object.defineProperty(DocTimeline.prototype, "currentTime", {
    get: function () {
      var t = realTime.call(this);
      return t === null ? null : now + (t - realTime.call(docTimeline));
    },
  });
  var getAnimations = Document.prototype.getAnimations;
  function syncAnimations() {
    var all = getAnimations.call(document);
    for (var i = 0; i < all.length; i++) {
      var a = all[i];
      if (!(a.timeline instanceof DocTimeline)) continue;
      a.pause();
      // Setting the time completes the pause at once, and with it a pending playback rate
      // (reverse(), updatePlaybackRate()), so playbackRate reads the rate it plays at.
      a.currentTime = 0;
      var rate = a.playbackRate;
      // Played backwards, an animation starts from its end.
      a.currentTime = rate < 0 && a.effect ? a.effect.getComputedTiming().endTime + now * rate : now * rate;
    }
  }
  Object.defineProperty(g, "__zrMotionClock", {
    value: Object.freeze({
      setFrame: function (n, fps) { now = (n * 1000) / fps; },
      syncAnimations: syncAnimations,
    }),
  });
})();
