// Injected at document creation (after qwebchannel.js). Rebuilds the exact
// FliksDesktopApi on window.fliksDesktop, backed by the QtWebChannel-exposed
// MpvObject ("mpv"). Method args/returns are JSON strings; QWebChannel methods
// take a trailing callback → wrapped as Promises. The Angular DesktopEngine
// consumes this unchanged.
(function () {
  function build(b) {
    function call(method) {
      var args = Array.prototype.slice.call(arguments, 1);
      return new Promise(function (resolve) {
        method.apply(b, args.concat([function (ret) { resolve(ret); }]));
      });
    }
    window.fliksDesktop = {
      runtime: 'electron',
      load: function (o) { return call(b.load, JSON.stringify(o)); },
      play: function () { return call(b.play); },
      pause: function () { return call(b.pause); },
      seek: function (p) { return call(b.seekTo, p); },
      stop: function () { return call(b.stop); },
      setPlaybackRate: function (r) { return call(b.setPlaybackRate, r); },
      setVolume: function (v) { return call(b.setVolume, v); },
      setMuted: function (m) { return call(b.setMuted, m); },
      setFullscreen: function (e) { return call(b.setFullscreen, e); },
      getPosition: function () { return call(b.getPosition).then(JSON.parse); },
      getAudioTracks: function () { return call(b.getAudioTracks).then(JSON.parse); },
      selectAudioTrack: function (id) { return call(b.selectAudioTrack, id); },
      getSubtitleTracks: function () { return call(b.getSubtitleTracks).then(JSON.parse); },
      selectSubtitleTrack: function (id) { return call(b.selectSubtitleTrack, id == null ? 'null' : id); },
      setSubtitleStyle: function (s) { return call(b.setSubtitleStyle, JSON.stringify(s)); },
      resize: function () { return Promise.resolve(); }, // the QML item fills the window
      destroy: function () { return call(b.destroyPlayer); },
      on: function (handler) {
        var fn = function (json) { handler(JSON.parse(json)); };
        b.desktopEvent.connect(fn);
        return function () { b.desktopEvent.disconnect(fn); };
      },
    };
    window.dispatchEvent(new Event('fliksDesktopReady'));
  }

  function init() {
    new QWebChannel(qt.webChannelTransport, function (channel) {
      build(channel.objects.mpv);
    });
  }

  // qt.webChannelTransport + the QWebChannel class may land slightly after this
  // script; poll briefly until both are ready.
  if (typeof QWebChannel !== 'undefined' && typeof qt !== 'undefined' && qt.webChannelTransport) {
    init();
  } else {
    var tries = 0;
    var t = setInterval(function () {
      if (typeof QWebChannel !== 'undefined' && typeof qt !== 'undefined' && qt.webChannelTransport) {
        clearInterval(t);
        init();
      } else if (++tries > 200) {
        clearInterval(t);
        console.error('[fliks] QWebChannel bridge unavailable');
      }
    }, 10);
  }
})();
