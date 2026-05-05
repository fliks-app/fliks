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
// CAF + Shaka discover EXT-X-MEDIA audio renditions in the HLS manifest
// but don't propagate them back to the sender as MediaInformation tracks.
// We mirror them manually so the sender can switch via the standard
// EditTracksInfoRequest, which rides the media bus and survives the
// transient sender-disconnect that happens shortly after every LOAD.

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
  // Push the updated media info to senders via MEDIA_STATUS so they see the
  // audio tracks in MediaInformation.tracks and can switch them via
  // EditTracksInfoRequest.
  playerManager.broadcastStatus(true);
  console.log(
    `[fliks-cast] published ${cafAudioTracks.length} audio tracks to media info`,
    cafAudioTracks.map((t) => ({ trackId: t.trackId, language: t.language, name: t.name })),
  );
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
    if (media && !media.textTrackStyle) {
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
    return loadRequest;
  },
);

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

const options = new cast.framework.CastReceiverOptions();
options.disableIdleTimeout = true;
options.useShakaForHls = true;
options.playbackConfig = new cast.framework.PlaybackConfig();
options.playbackConfig.autoResumeDuration = 5;
options.supportedCommands = cast.framework.messages.Command.ALL_BASIC_MEDIA;
context.start(options);
console.log('[fliks-cast] context.start called');
