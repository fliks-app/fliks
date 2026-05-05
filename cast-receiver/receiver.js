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

// Custom message bus shared with the Fliks sender for actions CAF doesn't
// expose natively. Today: HLS audio rendition switching — CAF + Shaka don't
// propagate EXT-X-MEDIA audio renditions back to the sender as Track objects,
// so the sender can't switch them via EditTracksInfoRequest.
const FLIKS_AUDIO_NAMESPACE = 'urn:x-cast:fliks.audio';

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

// --- Audio rendition switch (custom message bus) ------------------------
//
// Sender posts `{ language, name }` matching the master.m3u8 EXT-X-MEDIA
// attributes. We resolve via CAF's AudioTracksManager so the swap happens
// in-place (no LOAD round-trip, no ffmpeg restart).

context.addCustomMessageListener(FLIKS_AUDIO_NAMESPACE, (event) => {
  const { language, name } = event.data ?? {};
  if (!language) return;
  let mgr;
  try { mgr = playerManager.getAudioTracksManager(); } catch { return; }
  if (!mgr) return;
  const tracks = mgr.getTracks() ?? [];
  const matches = tracks.filter((t) => t.language === language);
  const target =
    matches.find((t) => t.name === name)
    ?? (matches.length === 1 ? matches[0] : null);
  if (!target) {
    console.warn(
      `[fliks-cast] audio switch: no unique match for language=${language} name=${name}`,
      tracks.map((t) => ({ trackId: t.trackId, language: t.language, name: t.name })),
    );
    return;
  }
  console.log(
    `[fliks-cast] audio switch → trackId=${target.trackId} (${language} / ${name})`,
  );
  mgr.setActiveById(target.trackId);
});

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
options.customNamespaces = {
  [FLIKS_AUDIO_NAMESPACE]: cast.framework.system.MessageType.JSON,
};
context.start(options);
console.log('[fliks-cast] context.start called');
