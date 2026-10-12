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
const { EdlSkipPolicy, MuteGate, decodeWire } = self.FliksEdl;

// Receiver → sender bus. A fatal player error is forwarded here so web
// senders can recover (refresh the live-session sid) or toast. Keep in
// sync with FLIKS_CAST_NAMESPACE in client cast.service.ts. Native senders
// detect the same fatal state via the Cast SDK's IDLE/ERROR status.
const FLIKS_NAMESPACE = 'urn:x-cast:media.fliks.app';

// Flip to false to stop asking Shaka for CMCD (unverified on real devices).
const CAST_CMCD = true;
const QOE_INTERVAL_MS = 5000;

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
    qoeLoaded();
    publishAudioTracks();
    startEdl();
  },
);

[
  cast.framework.events.EventType.MEDIA_FINISHED,
  cast.framework.events.EventType.ABORT,
  cast.framework.events.EventType.ENDED,
].forEach((evt) => {
  playerManager.addEventListener(evt, () => {
    document.body.classList.remove('playing');
    stopEdl();
  });
});

// Surface any player error on the device's DevTools console with the full
// CAF event payload (detailedErrorCode, reason, shaka-side error data).
playerManager.addEventListener(
  cast.framework.events.EventType.ERROR,
  (event) => {
    console.error('[fliks-cast] ERROR', JSON.stringify(event));
    document.body.classList.remove('playing');
    stopEdl();
    // Forward to web senders so they can refresh the sid and resume; the
    // sender classifies recoverable (network / 410) vs dead-end errors.
    try {
      const info = playerManager.getMediaInformation();
      const shakaErr = event && event.error;
      const data = shakaErr && Array.isArray(shakaErr.data) ? shakaErr.data : [];
      const httpStatus = typeof data[1] === 'number' ? data[1] : undefined;
      context.sendCustomMessage(FLIKS_NAMESPACE, undefined, {
        kind: 'player_error',
        detailedErrorCode: event ? event.detailedErrorCode : undefined,
        shakaErrorCode: shakaErr ? shakaErr.code : undefined,
        httpStatus: httpStatus,
        reason: event ? event.reason : undefined,
        mediaTitle: info && info.metadata ? info.metadata.title : undefined,
      });
    } catch (e) {
      console.warn('[fliks-cast] error forward failed', e);
    }
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

// --- Playback QoE ----------------------------------------------------------
//
// The receiver has no API auth: it pushes samples over FLIKS_NAMESPACE and the sender reports them.

const qoe = { playbackId: null, played: false, seeking: false, stallStart: null, stallCount: 0, stallMs: 0, stalls: [], lastSeekAt: 0, base: { dropped: 0, decoded: 0 }, statsBase: { dropped: 0, decoded: 0 } };
const EventType = cast.framework.events.EventType;

function qoeVideoQuality() {
  const el = findMediaElement();
  const q = el && typeof el.getVideoPlaybackQuality === 'function' ? el.getVideoPlaybackQuality() : null;
  return { dropped: q ? q.droppedVideoFrames : 0, decoded: q ? q.totalVideoFrames : 0 };
}

function qoeReset() {
  Object.assign(qoe, { played: false, seeking: false, stallStart: null, stallCount: 0, stallMs: 0, stalls: [] });
}

function qoeStats() {
  try { return playerManager.getStats() || {}; } catch { return {}; }
}

function qoeLoaded() {
  qoe.base = qoeVideoQuality();
  const st = qoeStats();
  qoe.statsBase = { dropped: qoeCount(st.droppedFrames) ?? 0, decoded: qoeCount(st.decodedFrames) ?? 0 };
}

playerManager.addEventListener(EventType.LOAD_START, qoeReset);
playerManager.addEventListener(EventType.PLAYING, () => { qoe.played = true; qoe.seeking = false; });
const SEEK_GRACE_MS = 2000;
playerManager.addEventListener(EventType.SEEKING, () => { qoe.seeking = true; qoe.lastSeekAt = Date.now(); });
playerManager.addEventListener(EventType.SEEKED, () => { qoe.lastSeekAt = Date.now(); });
playerManager.addEventListener(EventType.BUFFERING, (event) => {
  if (event.isBuffering) {
    if (qoe.stallStart == null && qoe.played && !qoe.seeking && Date.now() - qoe.lastSeekAt > SEEK_GRACE_MS) {
      const s = buildQoeSample();
      qoe.stallStart = Date.now();
      qoe.stallAt = { position: playerManager.getCurrentTimeSec(), bufferAheadS: s.bufferAheadS, bandwidthBps: s.bandwidthBps };
    }
  } else if (qoe.stallStart != null) {
    const durationMs = Date.now() - qoe.stallStart;
    qoe.stallCount += 1;
    qoe.stallMs += durationMs;
    qoe.stalls = [...qoe.stalls, { at: qoe.stallStart, durationMs, ...qoe.stallAt }].slice(-20);
    qoe.stallStart = null;
  }
});

function qoeCount(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

function qoeNum(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

function buildQoeSample() {
  const stats = qoeStats();
  const vq = qoeVideoQuality();
  const el = findMediaElement();
  let ahead = null;
  if (el) {
    for (let i = 0; i < el.buffered.length; i++) {
      if (el.currentTime >= el.buffered.start(i) && el.currentTime <= el.buffered.end(i)) {
        ahead = el.buffered.end(i) - el.currentTime;
      }
    }
  }
  const open = qoe.stallStart != null ? Date.now() - qoe.stallStart : 0;
  return {
    engine: 'cast',
    cmcd: CAST_CMCD,
    droppedFrames: qoeCount(stats.droppedFrames) != null
      ? Math.max(0, stats.droppedFrames - qoe.statsBase.dropped)
      : Math.max(0, vq.dropped - qoe.base.dropped),
    decodedFrames: qoeCount(stats.decodedFrames) != null
      ? Math.max(0, stats.decodedFrames - qoe.statsBase.decoded)
      : Math.max(0, vq.decoded - qoe.base.decoded),
    bandwidthBps: qoeNum(stats.estimatedBandwidth),
    bufferAheadS: ahead,
    variantBitrate: qoeNum(stats.streamBandwidth),
    width: qoeNum(stats.width) ?? qoeNum(el && el.videoWidth),
    height: qoeNum(stats.height) ?? qoeNum(el && el.videoHeight),
    videoCodec: null,
    decoderName: null,
    hwDecoder: null,
    stallCount: qoe.stallCount + (open ? 1 : 0),
    stallMs: qoe.stallMs + open,
    recoveryReloads: 0,
    stalls: qoe.stalls,
    ...(qoe.playbackId ? { playbackId: qoe.playbackId } : {}),
  };
}

setInterval(() => {
  if (!document.body.classList.contains('playing')) return;
  try {
    context.sendCustomMessage(FLIKS_NAMESPACE, undefined, { kind: 'qoe', at: Date.now(), sample: buildQoeSample() });
  } catch (e) {
    console.warn('[fliks-cast] qoe send failed', e);
  }
}, QOE_INTERVAL_MS);

// --- EDL (cut / commercial skip, mute ranges) ----------------------------
// Ranges arrive in LOAD customData.edl on the playback clock.

const edl = { key: null, ranges: [], labels: {}, policy: null, ended: false };
let edlMedia = null;
let edlGate = null;
let edlTimer = null;
let edlNoticeTimer = null;
const EDL_EVENTS = ['seeked', 'play', 'pause', 'ratechange', 'timeupdate'];

function edlSessionKey(media, cd) {
  if (cd && cd.mediaFileId != null) return `file:${cd.mediaFileId}`;
  if (cd && cd.mediaId != null) return `${cd.mediaId}:${cd.episodeId ?? ''}`;
  return String(media.contentId || '').split('?')[0];
}

// CAF has no getMediaElement(); the <video> sits in the DOM, possibly inside the player's shadow root.
function findMediaElement() {
  const player = document.querySelector('cast-media-player');
  return (
    document.querySelector('video.castMediaElement') ||
    (player && player.shadowRoot && player.shadowRoot.querySelector('video')) ||
    document.querySelector('cast-media-player video') ||
    document.querySelector('video')
  );
}

function showEdlNotice(action) {
  const text = edl.labels && edl.labels[action];
  const el = document.getElementById('edl-notice');
  if (!text || !el) return;
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(edlNoticeTimer);
  edlNoticeTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

function edlTick() {
  clearTimeout(edlTimer);
  const media = edlMedia;
  if (!edl.policy || !media || media.paused) return;
  const duration = playerManager.getDurationSec();
  const res = edl.policy.resolve(media.currentTime, duration);
  if (res.kind === 'end') {
    if (edl.ended) return;
    edl.ended = true;
    playerManager.seek(duration);
    return;
  }
  if (res.kind === 'seek') {
    showEdlNotice(res.action);
    playerManager.seek(res.to);
    return;
  }
  const boundary = edl.policy.nextBoundary(media.currentTime);
  if (!Number.isFinite(boundary)) return;
  const delay = ((boundary - media.currentTime) / (media.playbackRate || 1)) * 1000;
  edlTimer = setTimeout(() => {
    // Timer fired a hair early: nudge past the boundary so resolve() sees it reached.
    if (edlMedia && edlMedia.currentTime >= boundary - 0.03) {
      const r = edl.policy.resolve(boundary, playerManager.getDurationSec());
      if (r.kind === 'seek') {
        showEdlNotice(r.action);
        playerManager.seek(r.to);
        return;
      }
      if (r.kind === 'end') {
        edl.ended = true;
        playerManager.seek(playerManager.getDurationSec());
        return;
      }
    }
    edlTick();
  }, Math.max(0, delay));
}

function stopEdl() {
  clearTimeout(edlTimer);
  if (edlGate) edlGate.destroy();
  edlGate = null;
  if (edlMedia) EDL_EVENTS.forEach((e) => edlMedia.removeEventListener(e, edlTick));
  edlMedia = null;
}

function startEdl() {
  stopEdl();
  if (!edl.policy) return;
  const media = findMediaElement();
  if (!media) {
    console.warn('[fliks-cast] EDL: no media element found');
    return;
  }
  edlMedia = media;
  EDL_EVENTS.forEach((e) => media.addEventListener(e, edlTick));
  if (edl.ranges.some((r) => r.action === 'mute')) {
    edlGate = new MuteGate(media, edl.ranges);
  }
  edlTick();
}

function prepareEdl(media, loadRequest) {
  const cd = media.customData || {};
  qoe.playbackId = typeof cd.playbackId === 'string' ? cd.playbackId : null;
  const ranges = decodeWire(cd.edl);
  const key = edlSessionKey(media, cd);
  const auto = cd.autoSkipCommercials !== false;
  edl.ended = false;
  if (!ranges.length) {
    edl.key = key;
    edl.policy = null;
  } else if (key === edl.key && edl.policy) {
    // Same file keeps its skipped commercials across reloads (the timeline may have shifted).
    edl.policy.replaceRanges(ranges);
    edl.policy.setAutoSkipCommercials(auto);
  } else {
    edl.key = key;
    edl.policy = new EdlSkipPolicy(ranges, { autoSkipCommercials: auto });
  }
  edl.ranges = ranges;
  edl.labels = cd.edlLabels || {};
  if (!edl.policy) return;
  const res = edl.policy.resolve(loadRequest.currentTime || 0, media.duration);
  if (res.kind === 'seek') {
    loadRequest.currentTime = res.to;
    showEdlNotice(res.action);
  }
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
      prepareEdl(media, loadRequest);
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
options.customNamespaces = {
  [FLIKS_NAMESPACE]: cast.framework.system.MessageType.JSON,
  [CAPS_NAMESPACE]: cast.framework.system.MessageType.JSON,
};
options.playbackConfig = new cast.framework.PlaybackConfig();
options.playbackConfig.autoResumeDuration = 5;
if (CAST_CMCD) {
  options.playbackConfig.shakaConfig = { cmcd: { enabled: true, useHeaders: false } };
}
options.supportedCommands = cast.framework.messages.Command.ALL_BASIC_MEDIA;
context.start(options);
console.log('[fliks-cast] context.start called');
