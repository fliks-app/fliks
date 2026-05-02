/* eslint-disable no-undef */
/**
 * Fliks Cast Receiver — minimal CAF receiver bootstrap.
 *
 * The receiver is a thin shell:
 *   1. CAF SDK runs the player (HLS / MP4 via shaka-packaged Cast).
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

// --- Idle splash visibility ---------------------------------------------
//
// CAF doesn't expose a "media is showing" flag directly — we infer it from
// LOAD_START → ENDED transitions. body.playing toggles the splash via CSS.

playerManager.addEventListener(
  cast.framework.events.EventType.PLAYER_LOAD_COMPLETE,
  () => document.body.classList.add('playing'),
);

[
  cast.framework.events.EventType.MEDIA_FINISHED,
  cast.framework.events.EventType.PLAYER_LOAD_FAILED,
  cast.framework.events.EventType.ABORT,
  cast.framework.events.EventType.ENDED,
].forEach((evt) => {
  playerManager.addEventListener(evt, () =>
    document.body.classList.remove('playing'),
  );
});

// --- Subtitle styling baked into every load -----------------------------
//
// Senders may still override per-load via MediaInformation.textTrackStyle;
// this just ensures unstyled loads don't get CAF's default oversized
// yellow-on-black look on TV.

playerManager.setMessageInterceptor(
  cast.framework.messages.MessageType.LOAD,
  (loadRequest) => {
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
// `disableIdleTimeout: true` keeps the receiver alive between clips so
// queue/skip-intro features work later without re-launching the app.
// `playbackConfig` left at defaults — Shaka inside CAF handles HLS/DASH
// for us. CORS on the user's NAS responses is the only blocker; document
// in README.

context.start({
  disableIdleTimeout: true,
});
