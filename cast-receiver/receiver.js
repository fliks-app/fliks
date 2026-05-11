/* eslint-disable no-undef */
/**
 * Fliks Cast Receiver — minimal CAF receiver bootstrap.
 *
 * The receiver is a thin shell:
 *   1. CAF SDK runs the player. `useShakaForHls` switches HLS playback to
 *      Shaka — the same engine the Fliks web/Android paths use.
 *   2. We hook LOAD to apply Fliks-specific defaults (subtitle styling,
 *      idle splash toggling) and forward whatever the sender sent.
 *   3. customData is reserved for future-extension features
 *      (skip-intro markers, queue, watch-next) — currently the standard
 *      MediaInformation fields carry everything the player needs.
 *
 * Hosted at a single static URL registered once in Cast Console; users
 * never touch this code, their NAS just answers the stream URLs the
 * sender hands to the receiver.
 */

const context = cast.framework.CastReceiverContext.getInstance();
const playerManager = context.getPlayerManager();

// Verbose CAF + Shaka logging — surfaces in chrome://inspect on the
// receiver, the only practical way to diagnose a Cast freeze or load
// failure on a real device.
context.setLoggerLevel(cast.framework.LoggerLevel.DEBUG);
console.log('[fliks-cast] receiver boot start');

// --- Idle splash visibility ---------------------------------------------
//
// CAF doesn't expose a "media is showing" flag directly — we infer it from
// LOAD_START → ENDED transitions. body.playing toggles the splash via CSS.

playerManager.addEventListener(
  cast.framework.events.EventType.PLAYER_LOAD_COMPLETE,
  () => {
    console.log('[fliks-cast] PLAYER_LOAD_COMPLETE');
    document.body.classList.add('playing');
    publishAudioTracks();
  },
);

[
  cast.framework.events.EventType.MEDIA_FINISHED,
  cast.framework.events.EventType.ABORT,
  cast.framework.events.EventType.ENDED,
].forEach((evt) => {
  playerManager.addEventListener(evt, () =>
    document.body.classList.remove('playing'),
  );
});

// Surface any player error on the device's DevTools console with the full
// CAF event payload (detailedErrorCode, reason, shaka-side error data).
playerManager.addEventListener(
  cast.framework.events.EventType.ERROR,
  (event) => {
    console.error('[fliks-cast] ERROR', JSON.stringify(event));
    document.body.classList.remove('playing');
  },
);

// --- Expose Shaka audio renditions to the sender ------------------------
//
// CAF + Shaka discover EXT-X-MEDIA audio renditions but don't expose them
// to the sender as MediaInformation tracks. We mirror them manually so the
// sender can switch via the standard EditTracksInfoRequest on the media bus.

function publishAudioTracks() {
  let mgr;
  try { mgr = playerManager.getAudioTracksManager(); } catch { return; }
  if (!mgr) return;
  const audioRenditions = mgr.getTracks() ?? [];
  if (!audioRenditions.length) return;

  const info = playerManager.getMediaInformation();
  if (!info) return;

  const cafAudioTracks = audioRenditions.map((r) => {
    const track = new cast.framework.messages.Track(
      r.trackId,
      cast.framework.messages.TrackType.AUDIO,
    );
    track.language = r.language;
    track.name = r.name;
    return track;
  });

  // Keep any non-audio tracks (subtitles supplied by the sender) intact.
  const otherTracks = (info.tracks ?? []).filter(
    (t) => t.type !== cast.framework.messages.TrackType.AUDIO,
  );
  info.tracks = [...otherTracks, ...cafAudioTracks];
  playerManager.setMediaInformation(info);
  // Push the updated MediaInformation to senders via MEDIA_STATUS so the
  // new tracks land in their `media.tracks`.
  playerManager.broadcastStatus(true);
}

// --- Subtitle styling baked into every load -----------------------------
//
// Senders may still override per-load via MediaInformation.textTrackStyle;
// this just ensures unstyled loads don't get CAF's default oversized
// yellow-on-black look on TV.

playerManager.setMessageInterceptor(
  cast.framework.messages.MessageType.LOAD,
  (loadRequest) => {
    console.log(
      '[fliks-cast] LOAD intercepted — contentId=',
      loadRequest.media?.contentId,
      'contentType=',
      loadRequest.media?.contentType,
    );
    const media = loadRequest.media;
    if (media) {
      // Tell CAF the segments are fMP4 so Shaka picks the right HLS
      // demuxer up-front instead of probing seg-0 with the TS parser
      // (which fails silently on init.mp4 + .m4s output).
      media.hlsSegmentFormat =
        cast.framework.messages.HlsSegmentFormat.FMP4;
      media.hlsVideoSegmentFormat =
        cast.framework.messages.HlsVideoSegmentFormat.FMP4;
      if (!media.textTrackStyle) {
        const style = new cast.framework.messages.TextTrackStyle();
        style.fontGenericFamily =
          cast.framework.messages.TextTrackFontGenericFamily.SANS_SERIF;
        style.fontScale = 0.85;
        style.foregroundColor = '#FFFFFFFF';
        style.backgroundColor = '#00000000';
        style.edgeType = cast.framework.messages.TextTrackEdgeType.DROP_SHADOW;
        style.edgeColor = '#000000FF';
        media.textTrackStyle = style;
      }
    }
    return loadRequest;
  },
);

// --- Capability probe protocol ------------------------------------------
//
// Sender sends `{type:'probe'}` on the caps namespace and we reply with
// the list of audio/video codecs MediaSource actually accepts on this
// device. Lets the sender build an accurate device profile per-receiver:
// e.g. a Cast 2 reports AAC-only via MSE even though its hardware decodes
// AC-3 over HDMI passthrough — the sender needs the truthful MSE list,
// otherwise Shaka rejects the segment at chunk-demuxer append.
//
// Result is cached sender-side keyed on the device's friendly name, so
// only the first cast to a new device pays the probe round-trip.
const CAPS_NAMESPACE = 'urn:x-cast:app.fliks.caps';
const CAPS_AUDIO = [
  { codec: 'mp4a.40.2',       label: 'aac' },
  { codec: 'mp4a.40.5',       label: 'aac-he' },
  { codec: 'ac-3',            label: 'ac3' },
  { codec: 'ec-3',            label: 'eac3' },
  { codec: 'opus',            label: 'opus' },
];
const CAPS_VIDEO = [
  { codec: 'avc1.640028',         label: 'h264' },
  { codec: 'hvc1.1.6.L150.B0',    label: 'hevc' },
  { codec: 'vp09.00.50.08',       label: 'vp9' },
  { codec: 'av01.0.04M.08',       label: 'av1' },
];

console.log('[fliks-cast] registering caps listener on', CAPS_NAMESPACE);
context.addCustomMessageListener(CAPS_NAMESPACE, (event) => {
  console.log(
    '[fliks-cast] caps msg in:',
    'senderId=', event.senderId,
    'data=', JSON.stringify(event.data),
  );
  if (!event.data || event.data.type !== 'probe') return;
  const probe = (mime) => {
    try { return MediaSource.isTypeSupported(mime); } catch { return false; }
  };
  const audioCodecs = CAPS_AUDIO
    .filter((c) => probe(`audio/mp4; codecs="${c.codec}"`))
    .map((c) => c.label);
  const videoCodecs = CAPS_VIDEO
    .filter((c) => probe(`video/mp4; codecs="${c.codec}"`))
    .map((c) => c.label);
  const reply = { type: 'caps', audioCodecs, videoCodecs };
  console.log('[fliks-cast] caps probe →', JSON.stringify(reply));
  context.sendCustomMessage(CAPS_NAMESPACE, event.senderId, reply);
});

// --- Boot ---------------------------------------------------------------
//
// `useShakaForHls: true` makes CAF use Shaka for HLS — the same engine
// the Fliks web/Android paths use, so all three clients share buffering
// and ABR behaviour.
//
// `disableIdleTimeout: true` keeps the receiver alive between clips so
// queue/skip-intro features work later without re-launching the app.
// `autoResumeDuration: 5` starts/resumes playback on 5s of buffered media
// (default 10) — snappier resume after a seek or transient stall.
// `supportedCommands` is set explicitly so the sender's transport
// controls (play/pause/seek/skip-ad) are all advertised.
//
// Shaka's own buffering / retry knobs are left at their CAF defaults:
// Google's official guidance for `useShakaForHls` is "the default values
// set by the Web Receiver SDK are the recommended values", and the
// defaults are calibrated against the per-device MediaSource quotas that
// no override can lift.

const options = new cast.framework.CastReceiverOptions();
options.disableIdleTimeout = true;
options.useShakaForHls = true;
options.playbackConfig = new cast.framework.PlaybackConfig();
options.playbackConfig.autoResumeDuration = 5;
options.supportedCommands = cast.framework.messages.Command.ALL_BASIC_MEDIA;
context.start(options);
console.log('[fliks-cast] context.start called');
