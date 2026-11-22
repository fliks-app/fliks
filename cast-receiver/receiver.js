/* eslint-disable no-undef */
/**
 * Fliks Cast Receiver — minimal CAF receiver bootstrap.
 *
 * The receiver is a thin shell:
 *   1. CAF SDK runs the player. `useShakaForHls` switches HLS playback to
 *      Shaka — the same engine the Fliks web/Android paths use.
 *   2. We hook LOAD to apply Fliks-specific defaults (subtitle styling,
 *      idle splash toggling) and forward whatever the sender sent.
 *   3. customData carries what the standard MediaInformation lacks: the EDL, session and
 *      playback ids, cues, mixes and the party state (see README, customData contract).
 *
 * Hosted at static URLs registered once in Cast Console (release and staging); users
 * never touch this code, their NAS just answers the stream URLs the
 * sender hands to the receiver.
 */

const context = cast.framework.CastReceiverContext.getInstance();
const playerManager = context.getPlayerManager();
const { EdlSkipPolicy, MuteGate, decodeWire } = self.FliksEdl;
const { activeCue, cueText, bandGeometry } = self.FliksCues;
const { createAssembler, activeIndex, segments, createClock, claim, owns } = self.FliksLyrics;

// Receiver → sender bus. A fatal player error is forwarded here so web
// senders can recover (refresh the live-session sid) or toast. Keep in
// sync with FLIKS_CAST_NAMESPACE in client cast.service.ts. Native senders
// detect the same fatal state via the Cast SDK's IDLE/ERROR status.
const FLIKS_NAMESPACE = 'urn:x-cast:media.fliks.app';

// Flip to false to stop asking Shaka for CMCD (unverified on real devices).
const CAST_CMCD = true;
const QOE_INTERVAL_MS = 5000;

// DEBUG keeps every message payload in the console, tens of MB on a Cast device: diagnose by running
// context.setLoggerLevel(cast.framework.LoggerLevel.DEBUG) from chrome://inspect instead.
context.setLoggerLevel(cast.framework.LoggerLevel.WARNING);
console.log('[fliks-cast] receiver boot start');

// --- Idle splash visibility ---------------------------------------------
//
// body.playing hides the splash from the first loaded media until the player stays idle (renderBar): a LOAD
// replacing the media or the queue moving on passes through IDLE for a moment and keeps it hidden.

playerManager.addEventListener(
  cast.framework.events.EventType.PLAYER_LOAD_COMPLETE,
  () => {
    console.log('[fliks-cast] PLAYER_LOAD_COMPLETE');
    document.body.classList.add('playing');
    if (loadHold) Object.assign(loadHold, { loaded: true, until: Date.now() + LOAD_HOLD_SETTLE_MS });
    const current = playerManager.getQueueManager().getCurrentItem();
    if (current && current.itemId === upNext) upNext = null;
    renderMusic(playerManager.getMediaInformation());
    qoeLoaded();
    publishAudioTracks();
    startEdl();
    watchCaptionTracks();
  },
);

// The queue moving on switches the media before the next track has loaded.
playerManager.addEventListener(cast.framework.events.EventType.MEDIA_STATUS, () => renderMusic(playerManager.getMediaInformation()));

[
  cast.framework.events.EventType.MEDIA_FINISHED,
  cast.framework.events.EventType.ABORT,
  cast.framework.events.EventType.ENDED,
].forEach((evt) => playerManager.addEventListener(evt, stopEdl));

// Surface any player error on the device's DevTools console with the full
// CAF event payload (detailedErrorCode, reason, shaka-side error data).
playerManager.addEventListener(
  cast.framework.events.EventType.ERROR,
  (event) => {
    console.error('[fliks-cast] ERROR', JSON.stringify(event));
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
        mediaFileId: info && info.customData ? info.customData.mediaFileId : undefined,
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

const qoe = { playbackId: null, sid: null, played: false, seeking: false, stallStart: null, stallCount: 0, stallMs: 0, stalls: [], lastSeekAt: 0, base: { dropped: 0, decoded: 0 }, statsBase: { dropped: 0, decoded: 0 } };
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
      qoe.stallAt = { position: playerManager.getCurrentTimeSec(), bufferAheadS: s.bufferAheadS, bandwidthBps: s.bandwidthBps, variantBitrate: s.variantBitrate };
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
    context.sendCustomMessage(FLIKS_NAMESPACE, undefined, { kind: 'qoe', at: Date.now(), ...(qoe.sid ? { sid: qoe.sid } : {}), sample: buildQoeSample() });
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
  qoe.sid = typeof cd.sid === 'string' ? cd.sid : null;
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

// --- Skip cues ---------------------------------------------------------------
// The sender sends the intro/credits ranges and whether a next episode exists. A remote's keys
// may not reach a Web Receiver, so the cue is only a hint until a key event has actually been seen.

const cueEl = document.getElementById('skip-cue');
const cueState = { cues: null, fileId: null, sender: null, remoteKeys: false, shown: null };

function refreshCue() {
  const playing = document.body.classList.contains('playing');
  const cue = playing ? activeCue(cueState.cues, cueState.fileId, playerManager.getCurrentTimeSec()) : null;
  cueState.shown = cue;
  cueEl.classList.toggle('show', !!cue);
  cueEl.classList.toggle('actionable', !!cue && cueState.remoteKeys);
  if (cue) cueEl.textContent = cueText(cueState.cues, cue, cueState.remoteKeys);
}
setInterval(refreshCue, 500);

document.addEventListener('keydown', (e) => {
  const first = !cueState.remoteKeys;
  cueState.remoteKeys = true;
  if (first || cueState.shown === null || (e.key !== 'Enter' && e.keyCode !== 13)) return refreshCue();
  e.preventDefault();
  if (cueState.shown === 'intro') playerManager.seek(cueState.cues.intro.endSeconds);
  else context.sendCustomMessage(FLIKS_NAMESPACE, cueState.sender || undefined, { kind: 'next_episode' });
  cueEl.classList.remove('show');
});

context.addCustomMessageListener(FLIKS_NAMESPACE, (event) => {
  const msg = event.data;
  if (!msg || msg.kind !== 'cues') return;
  cueState.cues = msg;
  refreshCue();
  renderBar();
});

// --- Progress bar ---------------------------------------------------------------
// Own bar bound to the CAF player data; the default overlay (tv-overlay in the player's shadow root) is hidden.

const barEl = document.getElementById('bar');
const barTitle = barEl.querySelector('.bar-title');
const barSubtitle = barEl.querySelector('.bar-subtitle');
const barElapsed = barEl.querySelector('.bar-elapsed');
const barTotal = barEl.querySelector('.bar-total');
const barPlayed = barEl.querySelector('.bar-played');
const barBuffered = barEl.querySelector('.bar-buffered');
const barBands = barEl.querySelector('.bar-bands');
const barPlayer = document.querySelector('cast-media-player');
if (barPlayer && barPlayer.shadowRoot) {
  const hide = document.createElement('style');
  // Chrome lays native cues out from the picture (their height moved with the format) and ignores cue.line on
  // the Cast OS: the receiver draws them itself in #captions.
  hide.textContent =
    'tv-overlay { display: none !important; }' +
    'video::-webkit-media-text-track-container { display: none !important; }';
  barPlayer.shadowRoot.appendChild(hide);
}

const captionsEl = document.getElementById('captions');
let captionTrack = null;
let captionMargin = 5;

// A margin of m puts the captions about m vh above the bottom, like the local player.
function applyCaptionStyle(style) {
  const m = Number(style && style.customData && style.customData.bottomMargin);
  captionMargin = Number.isFinite(m) ? m : 5;
  const css = FliksCaptions.captionStyle(style);
  captionsEl.style.setProperty('--sub-bottom', captionMargin + 1 + 'vh');
  captionsEl.style.setProperty('--cap-bg', css.background);
  Object.assign(captionsEl.style, {
    fontSize: css.fontSize, fontFamily: css.fontFamily, color: css.color, textShadow: css.textShadow,
  });
}

function renderCaptions() {
  captionsEl.textContent = '';
  const cues = captionTrack && captionTrack.mode === 'showing' ? captionTrack.activeCues : null;
  for (const cue of cues ? Array.from(cues) : []) {
    const line = document.createElement('div');
    const text = document.createElement('span');
    text.className = 'cue';
    if (cue.getCueAsHTML) text.appendChild(cue.getCueAsHTML());
    else text.textContent = cue.text;
    line.appendChild(text);
    captionsEl.appendChild(line);
  }
}

/** Follows the track CAF shows: a sender's subtitle pick or Off changes it. */
function followCaptionTrack() {
  const media = findMediaElement();
  const showing = media ? Array.from(media.textTracks).find((t) => t.mode === 'showing') || null : null;
  if (showing !== captionTrack) {
    if (captionTrack) captionTrack.removeEventListener('cuechange', renderCaptions);
    captionTrack = showing;
    if (captionTrack) captionTrack.addEventListener('cuechange', renderCaptions);
  }
  renderCaptions();
}

function watchCaptionTracks() {
  const media = findMediaElement();
  if (!media) return;
  media.textTracks.onchange = followCaptionTrack;
  media.textTracks.onaddtrack = followCaptionTrack;
  followCaptionTrack();
}

function formatClock(sec) {
  const t = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  const s = String(t % 60).padStart(2, '0');
  const m = Math.floor(t / 60) % 60;
  const h = Math.floor(t / 3600);
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function bufferedEnd(el, time) {
  if (!el) return 0;
  for (let i = 0; i < el.buffered.length; i++) {
    if (time >= el.buffered.start(i) && time <= el.buffered.end(i)) return el.buffered.end(i);
  }
  return 0;
}

const playerData = {};
const playerBinder = new cast.framework.ui.PlayerDataBinder(playerData);
const BarState = cast.framework.ui.State;
let barBandsKey = '';

const SPLASH_IDLE_MS = 1500;
let splashTimer = 0;

const spinnerEl = document.getElementById('spinner');
const stateIconEl = document.getElementById('state-icon');
let iconState = null;
let iconTimer = 0;

function renderStateIcon(st, spinning) {
  stateIconEl.classList.toggle('instant', spinning);
  if (st === iconState) return;
  const resumed = iconState === BarState.PAUSED && st === BarState.PLAYING;
  iconState = st;
  clearTimeout(iconTimer);
  stateIconEl.classList.toggle('paused', st === BarState.PAUSED);
  stateIconEl.classList.toggle('show', st === BarState.PAUSED || resumed);
  if (resumed) iconTimer = setTimeout(() => stateIconEl.classList.remove('show'), 600);
}

// A LOAD of the playing file (a stem switch) reports the old media's time, then 0, until its start time:
// the views hold that time and the file's duration meanwhile.
const LOAD_HOLD_MS = 15000;
const LOAD_HOLD_SETTLE_MS = 2000;
let loadHold = null;
function heldLoad() {
  const h = loadHold;
  if (h && (Date.now() > h.until || (h.loaded && Math.abs(playerManager.getCurrentTimeSec() - h.at) <= 1.5))) loadHold = null;
  return loadHold;
}

function renderBar() {
  const st = playerData.state;
  const spinning = st === BarState.LOADING || st === BarState.BUFFERING;
  renderStateIcon(st, spinning);
  spinnerEl.classList.toggle('show', spinning);
  const idle = !st || st === BarState.IDLE || st === BarState.LAUNCHING;
  clearTimeout(splashTimer);
  if (idle) splashTimer = setTimeout(() => document.body.classList.remove('playing'), SPLASH_IDLE_MS);
  const hold = heldLoad();
  const rawDuration = hold ? hold.duration : playerData.duration;
  const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0;
  const time = hold ? hold.at : playerData.currentTime || 0;
  const pct = (v) => (duration ? Math.min(100, (v / duration) * 100) : 0) + '%';
  const music = document.body.classList.contains('music-on');
  if (music) {
    renderMusicState(st);
    renderMusicProgress(formatClock(time), duration ? formatClock(duration) : '', duration ? Math.min(1, time / duration) : 0);
  }
  // The music view shows its own progress.
  const show = !idle && !music && (playerData.displayStatus || playerData.isSeeking || st === BarState.PAUSED);
  barEl.classList.toggle('show', show);
  document.body.classList.toggle('bar-on', show);
  if (barPlayer) barPlayer.classList.toggle('bar-on', show);
  if (!show) return;
  // An episode leads with its own label (`subtitle`), the series name under it; any other subtitle (artists) stays below.
  const info = playerManager.getMediaInformation();
  const episode = !!(playerData.subtitle && info && info.customData && info.customData.episodeId);
  barTitle.textContent = (episode ? playerData.subtitle : playerData.title) || '';
  barSubtitle.textContent = (episode ? playerData.title : playerData.subtitle) || '';
  barTitle.classList.toggle('small', episode);
  // Just above the bar's text, whose height depends on the title lines; never below the margin.
  const textTop = (innerHeight - barTitle.getBoundingClientRect().top) / innerHeight * 100;
  captionsEl.style.setProperty('--sub-bottom-bar', Math.max(captionMargin + 1, textTop + 1.5).toFixed(1) + 'vh');
  barElapsed.textContent = formatClock(time);
  barTotal.textContent = duration ? formatClock(duration) : '';
  barPlayed.style.width = pct(time);
  barBuffered.style.width = pct(bufferedEnd(findMediaElement(), time));
  const bands = bandGeometry(cueState.cues, cueState.fileId, duration);
  const key = JSON.stringify(bands);
  if (key === barBandsKey) return;
  barBandsKey = key;
  barBands.textContent = '';
  bands.forEach((b) => {
    const el = document.createElement('div');
    el.className = 'bar-band ' + b.kind;
    el.style.left = b.left + '%';
    el.style.width = b.width + '%';
    barBands.appendChild(el);
  });
}
playerBinder.addEventListener(cast.framework.ui.PlayerDataEventType.ANY_CHANGE, renderBar);

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
    // CAF runs this for the queued track it preloads too: the playing track and its mix stay as they are.
    if (media && upNextUrl && media.contentId === upNextUrl && playerManager.getPlayerState() !== cast.framework.messages.PlayerState.IDLE) return loadRequest;
    // A LOAD starts a new queue: the up-next item went with the old one.
    upNext = null;
    upNextUrl = null;
    const prevFile = fileOf(playerManager.getMediaInformation());
    const prevDuration = playerData.duration;
    loadHold = null;
    if (activeMix) closeMix(activeMix);
    const mixId = media && typeof media.contentId === 'string' && media.contentId.startsWith(MIX_SCHEME) ? media.contentId.slice(MIX_SCHEME.length) : null;
    if (mixId && mixSpecs.has(mixId)) {
      activeMix = startMix(mixId, mixSpecs.get(mixId), loadRequest.currentTime || 0);
      media.contentUrl = activeMix.url;
      media.contentType = 'audio/mp4';
    }
    renderMusic(media);
    // A track's view needs nothing loaded: it replaces the splash while the audio buffers.
    if (document.body.classList.contains('music-on')) document.body.classList.add('playing');
    if (media) {
      prepareEdl(media, loadRequest);
      if (prevFile !== null && fileOf(media) === prevFile) {
        loadHold = { at: loadRequest.currentTime || 0, duration: prevDuration, loaded: false, until: Date.now() + LOAD_HOLD_MS };
      }
      cueState.fileId = media.customData ? media.customData.mediaFileId ?? null : null;
      cueState.sender = loadRequest.senderId || null;
      if (cueState.sender && claim(lyricsState, cueState.sender)) dropLyrics();
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
      applyCaptionStyle(media.textTrackStyle);
    }
    return loadRequest;
  },
);

playerManager.setMessageInterceptor(
  cast.framework.messages.MessageType.EDIT_TRACKS_INFO,
  (request) => {
    if (request.textTrackStyle) applyCaptionStyle(request.textTrackStyle);
    return request;
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

// Audio files the receiver opens as they are, in the server's container and codec names.
const CAPS_AUDIO_FILES = [
  { mime: 'audio/mpeg',                    containers: ['mp3'],        codecs: ['mp3'] },
  { mime: 'audio/aac',                     containers: ['aac'],        codecs: ['aac'] },
  { mime: 'audio/mp4; codecs="mp4a.40.2"', containers: ['m4a', 'mp4'], codecs: ['aac'] },
  { mime: 'audio/flac',                    containers: ['flac'],       codecs: ['flac'] },
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
  const audioEl = new Audio();
  const files = CAPS_AUDIO_FILES.filter((f) => !!audioEl.canPlayType(f.mime));
  const unique = (list) => [...new Set(list)];
  // v2 adds the 10-bit and HDR fields, v3 the audio files; senders ignore what they do not know.
  let hdr = false;
  try {
    hdr = !!context.getDeviceCapabilities?.()?.[cast.framework.system.DeviceCapabilities.IS_HDR_SUPPORTED];
  } catch { /* old firmware: no capability API */ }
  const reply = {
    type: 'caps', v: 3, audioCodecs, videoCodecs, hdr,
    audioFiles: {
      containers: unique(files.flatMap((f) => f.containers)),
      videoCodecs: [],
      audioCodecs: unique(files.flatMap((f) => f.codecs)),
    },
    hevcMain10: probe('video/mp4; codecs="hvc1.2.4.L150.B0"'),
    av1Main10: probe('video/mp4; codecs="av01.0.08M.10"'),
  };
  console.log('[fliks-cast] caps probe →', JSON.stringify(reply));
  context.sendCustomMessage(CAPS_NAMESPACE, event.senderId, reply);
});

// --- Party reactions and chat bubbles ------------------------------------
//
// A sender relays the party's floating reactions and chat; only the first one to send is
// followed, so two phones in the same party do not double every item.

const MAX_REACTIONS = 8;
const MAX_BUBBLES = 3;
let partySender = null;

const partyLayer = document.getElementById('party-layer');
const reactionBox = partyLayer.querySelector('.party-reactions');
const bubbleBox = partyLayer.querySelector('.party-bubbles');

// Shown only while it holds something: even empty, a full-screen layer costs the Cast compositor its memory.
const syncPartyLayer = () => partyLayer.classList.toggle('busy', reactionBox.childElementCount + bubbleBox.childElementCount > 0);
const dropOnEnd = (el) => el.addEventListener('animationend', () => { el.remove(); syncPartyLayer(); });
const trim = (box, max) => { while (box.children.length > max) box.firstChild.remove(); };

// The bundled copy works over HTTPS; the sender's URL covers anything not bundled.
function emojiNode(emoji, img) {
  const glyph = () => { const t = document.createElement('span'); t.textContent = emoji; return t; };
  // The sender only sends an image for the animated set; anything else draws from the emoji font.
  if (typeof img !== 'string' || !/^https?:/i.test(img)) return glyph();
  const code = Array.from(emoji, (c) => c.codePointAt(0).toString(16)).join('_');
  const sources = ['emoji/' + code + '.webp', img];
  const node = document.createElement('img');
  node.alt = emoji;
  node.onerror = () => {
    const next = sources.shift();
    if (next) node.src = next; else node.replaceWith(glyph());
  };
  node.onerror();
  return node;
}

// A 10 MB font, so not loaded at boot: memory is what a Cast device lacks. The sender's `party_on` loads it ahead.
let emojiFont = null;
const loadEmojiFont = () => (emojiFont ??= document.fonts.load('1em "Fliks Emoji"', '\u{1F600}').catch(() => {}));

function partyFloat(msg) {
  if (!msg || typeof msg !== 'object') return;
  // Waits for the emoji font so the first emoji is not drawn as tofu.
  loadEmojiFont().then(() => showParty(msg));
}
self.partyFloat = partyFloat;

function showParty(msg) {
  if (msg.kind === 'party_reaction' && typeof msg.emoji === 'string') {
    const el = document.createElement('div');
    el.className = 'party-reaction';
    el.style.left = (10 + Math.random() * 80) + '%';
    el.appendChild(emojiNode(msg.emoji, msg.img));
    dropOnEnd(el);
    reactionBox.appendChild(el);
    trim(reactionBox, MAX_REACTIONS);
    syncPartyLayer();
  } else if (msg.kind === 'party_chat' && typeof msg.text === 'string') {
    const el = document.createElement('div');
    el.className = 'party-bubble';
    const name = document.createElement('b');
    name.textContent = String(msg.username || '');
    const text = document.createElement('span');
    text.textContent = String(msg.sep || ': ') + msg.text;
    el.append(name, text);
    dropOnEnd(el);
    bubbleBox.appendChild(el);
    trim(bubbleBox, MAX_BUBBLES);
    syncPartyLayer();
  }
}

context.addCustomMessageListener(FLIKS_NAMESPACE, (event) => {
  const msg = event.data;
  if (!msg || typeof msg.kind !== 'string' || !msg.kind.startsWith('party_')) return;
  if (partySender && partySender !== event.senderId) return;
  partySender = event.senderId;
  partyFloat(msg);
});
context.addEventListener(cast.framework.system.EventType.SENDER_DISCONNECTED, (event) => {
  if (event.senderId === partySender) partySender = null;
});

// --- Lyrics -----------------------------------------------------------------
// The sender pushes the document in chunks (`lyrics`) and drops it with `lyrics_clear`; the receiver follows its own clock.

const lyricsEl = document.getElementById('lyrics');
const lyricsState = { doc: null, sender: null, shown: -2, built: null, list: null, rows: [], words: [], wipes: [], add: createAssembler() };
// A word is drawn twice, its sung copy clipped from the left and its coming copy from the right, each clip and its text
// moving against each other: transforms only, so the compositor runs the wipe, and the copies never overlap.
const LEFT = 'translateX(-100%)';
const RIGHT = 'translateX(100%)';
const WIPES = [[LEFT, 'none'], [RIGHT, 'none'], ['none', RIGHT], ['none', LEFT]].map(([a, b]) => [{ transform: a }, { transform: b }]);
const WIPE_SLACK_MS = 80;
const lyricsClock = createClock(400);

/** A timed word, or the text between two, its spaces left outside so the line still wraps between words. */
function wordEl(line, text, className) {
  const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  if (!core) return void line.append(text);
  const el = document.createElement('span');
  el.className = className;
  el.textContent = core;
  line.append(lead, el, trail);
  return { el, text: core, gap: className !== 'word' };
}

/** Every line of the document in one column, words wrapped where a line has cues. */
function buildLyrics(doc, timed) {
  stopWipes();
  const list = document.createElement('div');
  list.className = 'lyrics-list' + (timed ? '' : ' static') + (doc.stage ? ' stage' : '');
  lyricsState.rows = [];
  lyricsState.words = [];
  doc.rows.forEach((row) => {
    const line = document.createElement('div');
    const cues = row.cues && row.cues.length ? row.cues : null;
    line.className = cues ? 'lyric cued' : 'lyric';
    const words = [];
    let prev = null;
    if (!cues) line.append(row.text);
    for (const seg of cues ? segments(row.text, cues) : []) {
      const cue = seg.cue === null ? null : cues[seg.cue];
      // As on the phone, the text between words lights once the word before it is sung, a leading one with the first.
      const start = cue ? cue.start : prev ? prev.end : cues[0].start;
      const el = wordEl(line, seg.text, cue ? 'word' : 'word gap');
      if (el) words.push({ start, end: cue ? cue.end : start, ...el });
      if (cue) prev = cue;
    }
    list.appendChild(line);
    lyricsState.rows.push(line);
    lyricsState.words.push(words);
  });
  lyricsEl.replaceChildren(list);
  lyricsState.list = list;
  lyricsState.built = doc;
  lyricsState.shown = -2;
}

/** Scrolls the column so line `i` sits at the middle, at once on a new document; before the first line, the first one waits there. */
function showLine(i, instant) {
  lyricsState.rows.forEach((line, k) => {
    line.classList.toggle('cur', k === i);
    line.classList.toggle('past', k < i);
  });
  const line = lyricsState.rows[Math.max(i, 0)];
  const { list } = lyricsState;
  if (!line) return;
  if (instant) list.style.transition = 'none';
  list.style.transform = `translateY(${-(line.offsetTop + line.offsetHeight / 2)}px)`;
  if (!instant) return;
  void list.offsetHeight;
  list.style.transition = '';
}

function stopWipes() {
  for (const w of lyricsState.wipes) {
    w.anims.forEach((a) => a.cancel());
    w.el.classList.remove('wiping');
    w.el.textContent = w.text;
  }
  lyricsState.wipes = [];
}

/** Gives the words of line `i` their two copies, only there since each is a layer, and arms their wipes on the
    media clock (syncWipes). The karaoke stage never lights the text between words. */
function wipeLine(i) {
  stopWipes();
  for (const w of lyricsState.words[i] || []) {
    if (w.gap && lyricsState.doc.stage) continue;
    const layers = [];
    for (const side of ['sung', 'coming']) {
      const clip = document.createElement('span');
      clip.className = 'clip ' + side;
      const copy = document.createElement('span');
      copy.textContent = w.text;
      clip.appendChild(copy);
      w.el.appendChild(clip);
      layers.push(clip, copy);
    }
    w.el.classList.add('wiping');
    const timing = { duration: Math.max(1, w.end - w.start), fill: 'both', easing: 'linear' };
    lyricsState.wipes.push({ el: w.el, text: w.text, start: w.start, duration: timing.duration, anims: layers.map((el, k) => el.animate(WIPES[k], timing)) });
  }
}

/** The wipes follow the playback state, and are moved only when they drift from the media clock `t`. */
function syncWipes(t, playing) {
  for (const w of lyricsState.wipes) {
    const at = Math.min(t - w.start, w.duration);
    for (const a of w.anims) {
      if (playing && a.playState === 'paused') a.play();
      else if (!playing && a.playState !== 'paused') a.pause();
      if (Math.abs(a.currentTime - at) > WIPE_SLACK_MS) a.currentTime = at;
    }
  }
}

function refreshLyrics() {
  const { doc } = lyricsState;
  // A document belongs to its track: the next one's arrives just after the queue moves on.
  const visible = !!doc && doc.itemId === playingItemId() && document.body.classList.contains('playing');
  document.body.classList.toggle('lyrics-on', visible);
  if (!visible) return lyricsEl.classList.remove('show');
  const timed = doc.synced && doc.rows.every((r) => r.start !== undefined && r.start !== null);
  if (lyricsState.built !== doc) buildLyrics(doc, timed);
  lyricsEl.classList.add('show');
  if (!timed) return;
  const playing = playerManager.getPlayerState() === cast.framework.messages.PlayerState.PLAYING;
  const hold = heldLoad();
  const pos = lyricsClock((hold ? hold.at : playerManager.getCurrentTimeSec()) * 1000, performance.now(), playing);
  const i = activeIndex(doc.rows, pos, doc.offset);
  if (i !== lyricsState.shown) {
    const fresh = lyricsState.shown === -2;
    lyricsState.shown = i;
    showLine(i, fresh);
    wipeLine(i);
  }
  syncWipes(pos + (doc.offset || 0), playing);
}
setInterval(refreshLyrics, 100);

function dropLyrics() {
  stopWipes();
  lyricsState.doc = null;
  lyricsState.built = null;
  lyricsState.list = null;
  lyricsState.rows = [];
  lyricsState.words = [];
  lyricsState.shown = -2;
  lyricsState.add = createAssembler();
  lyricsEl.classList.remove('show');
  lyricsEl.replaceChildren();
}

context.addCustomMessageListener(FLIKS_NAMESPACE, (event) => {
  const msg = event.data;
  if (!msg || (msg.kind !== 'lyrics' && msg.kind !== 'lyrics_clear')) return;
  if (!owns(lyricsState, event.senderId)) return;
  lyricsState.sender = event.senderId;
  if (msg.kind === 'lyrics_clear') return dropLyrics();
  const doc = lyricsState.add(msg);
  if (doc) lyricsState.doc = doc;
});
context.addEventListener(cast.framework.system.EventType.SENDER_DISCONNECTED, (event) => {
  if (event.senderId === lyricsState.sender) {
    lyricsState.sender = null;
    dropLyrics();
  }
});

// --- Up next ----------------------------------------------------------------
// The sender queues the next music track ahead of the end of the current one; CAF moves on to it by itself,
// with no IDLE in between. One item at most: a new one replaces it, `media: null` drops it.

const UP_NEXT_PRELOAD_S = 15;
let upNext = null;
let upNextUrl = null;

function queuedMedia(m) {
  const media = new cast.framework.messages.MediaInformation();
  media.contentId = m.url;
  media.contentUrl = m.url;
  media.contentType = m.contentType;
  media.streamType = cast.framework.messages.StreamType.BUFFERED;
  media.hlsSegmentFormat = cast.framework.messages.HlsSegmentFormat.FMP4;
  const meta = new cast.framework.messages.GenericMediaMetadata();
  meta.title = m.title || '';
  meta.subtitle = m.subtitle || '';
  if (m.posterUrl) meta.images = [new cast.framework.messages.Image(m.posterUrl)];
  media.metadata = meta;
  media.customData = m.customData || {};
  return media;
}

context.addCustomMessageListener(FLIKS_NAMESPACE, (event) => {
  const msg = event.data;
  if (!msg || msg.kind !== 'queue_next') return;
  const queue = playerManager.getQueueManager();
  const current = queue.getCurrentItem();
  // The queue may already have moved on to it: never drop the playing item.
  if (upNext !== null && (!current || current.itemId !== upNext)) queue.removeItems([upNext]);
  upNext = null;
  upNextUrl = msg.media ? msg.media.url : null;
  if (!msg.media) return;
  const item = new cast.framework.messages.QueueItem();
  item.media = queuedMedia(msg.media);
  item.autoplay = true;
  item.preloadTime = UP_NEXT_PRELOAD_S;
  queue.insertItems([item]);
  const items = queue.getItems() || [];
  upNext = items.length ? items[items.length - 1].itemId : null;
  console.log('[fliks-cast] up next', upNext, msg.media.title);
});

// --- Music view -------------------------------------------------------------
// A music track (its LOAD carries an `itemId`) shows its cover over its own artwork blurred, the lyrics beside it.

const musicEl = document.getElementById('music');
const musicBackdrop = musicEl.querySelector('.music-backdrop');
const musicCover = musicEl.querySelector('.music-cover');
const musicTitle = musicEl.querySelector('.music-title-text');
const musicState = musicEl.querySelector('.music-state');
const musicArtist = musicEl.querySelector('.music-artist');
const musicElapsed = musicEl.querySelector('.music-elapsed');
const musicTotal = musicEl.querySelector('.music-total');
const musicPlayed = musicEl.querySelector('.music-played');

function musicItemId(info) {
  const id = info && info.customData ? info.customData.itemId : undefined;
  return typeof id === 'number' ? id : null;
}

function fileOf(info) {
  const id = info && info.customData ? info.customData.mediaFileId : undefined;
  return typeof id === 'number' ? id : null;
}

function playingItemId() {
  return musicItemId(playerManager.getMediaInformation());
}

/** Shows the view of `info` from its LOAD on, so the video bar never shows first; a status without media keeps it. */
function renderMusic(info) {
  if (!info) return;
  const music = musicItemId(info) !== null;
  document.body.classList.toggle('music-on', music);
  if (!music) return;
  const meta = info.metadata || {};
  const cover = meta.images && meta.images.length ? meta.images[0].url : '';
  if ((musicCover.getAttribute('src') || '') !== cover) {
    if (cover) musicCover.setAttribute('src', cover);
    else musicCover.removeAttribute('src');
    paintBackdrop(cover);
  }
  musicTitle.textContent = meta.title || '';
  musicArtist.textContent = meta.subtitle || meta.artist || '';
}

/** The cover blurred once into a small canvas the page scales up: a CSS blur over the whole screen renders coarse on Cast. */
function paintBackdrop(cover) {
  musicBackdrop.classList.remove('shown');
  if (!cover) return;
  const img = new Image();
  img.onload = () => {
    if (musicCover.getAttribute('src') !== cover) return;
    const ctx = musicBackdrop.getContext('2d');
    const { width, height } = musicBackdrop;
    const side = Math.max(width, height) * 1.4;
    ctx.filter = 'blur(9px) saturate(1.5) brightness(0.62)';
    ctx.drawImage(img, (width - side) / 2, (height - side) / 2, side, side);
    musicBackdrop.classList.add('shown');
  };
  img.src = cover;
}

function renderMusicState(st) {
  musicState.className = 'music-state ' + (st === BarState.PLAYING ? 'playing' : st === BarState.PAUSED ? 'paused' : 'waiting');
}

/** Text only when it changes and the bar by transform: the player data changes many times a second. */
function renderMusicProgress(elapsed, total, fraction) {
  if (musicElapsed.textContent !== elapsed) musicElapsed.textContent = elapsed;
  if (musicTotal.textContent !== total) musicTotal.textContent = total;
  musicPlayed.style.transform = `scaleX(${fraction})`;
}

// --- Mixes ------------------------------------------------------------------
// A sender declares a mix (`mix`: 16-bit PCM sources, each with its gain) and LOADs `fliks-mix:<id>`. The receiver
// streams the sources, sums them and feeds the media element through MSE (mixer.js): a gain change remixes what is
// buffered ahead, with no reload.

const { BLOCK, mix, flacFrame, initSegment, mediaSegment } = self.FliksMixer;
const MIX_SCHEME = 'fliks-mix:';
const MIX_AHEAD_S = 3;
const MIX_REMIX_LEAD_S = 0.3;
const MIX_KEEP_S = 10;
const MIX_SEGMENT_BLOCKS = 6;
// Four segments per request: a window of each source stays a few hundred KB in the page.
const MIX_WINDOW_S = (BLOCK * MIX_SEGMENT_BLOCKS * 4) / 48000;
const mixSpecs = new Map();
let activeMix = null;

/** One SourceBuffer operation at a time, in order. */
function mixOp(m, fn) {
  m.ops = m.ops.then(() => {
    if (m.closed) return;
    fn();
    return m.sb.updating ? new Promise((r) => m.sb.addEventListener('updateend', r, { once: true })) : undefined;
  }).catch((e) => console.warn('[fliks-cast] mix op', e));
  return m.ops;
}

/** Appends the mix of `raw` (per-source samples from frame `start`) as segments of whole blocks. */
function appendMix(m, start, raw) {
  const frames = raw[0].length / m.channels;
  const mixed = mix(raw, m.gains);
  for (let at = 0; at < frames; at += BLOCK * MIX_SEGMENT_BLOCKS) {
    const list = [];
    const durations = [];
    for (let f = at; f < Math.min(frames, at + BLOCK * MIX_SEGMENT_BLOCKS); f += BLOCK) {
      const chunk = mixed.subarray(f * m.channels, Math.min(frames, f + BLOCK) * m.channels);
      list.push(flacFrame(chunk, m.channels, m.rate, start + f));
      durations.push(chunk.length / m.channels);
    }
    const segment = mediaSegment(++m.seq, start + at, list, durations);
    mixOp(m, () => m.sb.appendBuffer(segment));
  }
}

/** Every source's PCM from `fromS` to `toS` seconds, in parallel; one window at a time, since the browser buffers a whole
    response however slowly the page reads it. */
async function fetchWindow(m, fromS, toS, signal) {
  const rs = await Promise.all(m.sources.map((src) =>
    fetch(src.url + (src.url.includes('?') ? '&' : '?') + 'from=' + fromS.toFixed(6) + '&to=' + toS.toFixed(6), { signal })));
  const range = /bytes (\d+)-\d+\/(\d+)/.exec(rs[0].headers.get('content-range') || '');
  return { type: rs[0].headers.get('content-type') || '', range, data: await Promise.all(rs.map((r) => r.arrayBuffer())) };
}

/** Streams the sources in from `fromS`, a window ahead of the playhead, until they end or a newer run starts. */
async function runMix(m, fromS) {
  const run = ++m.run;
  m.abort.abort();
  m.abort = new AbortController();
  const { signal } = m.abort;
  let w = await fetchWindow(m, fromS, fromS + MIX_WINDOW_S, signal);
  if (run !== m.run) return;
  const format = /rate=(\d+);\s*channels=(\d+)/.exec(w.type);
  if (!format || !w.range) throw new Error('not a ranged PCM source');
  const frameBytes = 2 * +format[2];
  const total = +w.range[2] / frameBytes;
  if (!m.sb) {
    m.rate = +format[1];
    m.channels = +format[2];
    m.sb = m.ms.addSourceBuffer('audio/mp4; codecs="flac"');
    // The length before the init segment: CAF seeks to the LOAD's position once the metadata is in.
    m.ms.duration = total / m.rate;
    mixOp(m, () => m.sb.appendBuffer(initSegment(m.rate, m.channels)));
  }
  m.base = +w.range[1] / frameBytes;
  m.end = m.base;
  m.raw = [];
  const media = findMediaElement();
  // Ahead of the playhead, or of the run's start while the element has not seeked there yet.
  const ahead = () => m.end / m.rate - Math.max(media ? media.currentTime : 0, m.base / m.rate);
  // Mid-frame seconds, so the server's floor lands on the frame.
  const at = (frame) => (frame + 0.5) / m.rate;
  for (;;) {
    const frames = Math.floor(Math.min(...w.data.map((d) => d.byteLength)) / frameBytes);
    if (frames <= 0) break;
    const raw = w.data.map((d) => new Int16Array(d, 0, frames * m.channels));
    appendMix(m, m.end, raw);
    // The element waits where nothing was appended: it starts with the run.
    if (m.end === m.base && media) mixOp(m, () => { if (media.currentTime < m.base / m.rate) media.currentTime = m.base / m.rate; });
    m.raw.push({ start: m.end, raw });
    m.end += frames;
    const played = media ? Math.floor(media.currentTime * m.rate) : 0;
    while (m.raw.length && m.raw[0].start + m.raw[0].raw[0].length / m.channels <= played) m.raw.shift();
    if (media && media.currentTime > MIX_KEEP_S) mixOp(m, () => m.sb.remove(0, media.currentTime - MIX_KEEP_S));
    if (m.end >= total) break;
    while (ahead() > MIX_AHEAD_S && run === m.run) await new Promise((r) => setTimeout(r, 200));
    if (run !== m.run) return;
    w = await fetchWindow(m, at(m.end), at(m.end + MIX_WINDOW_S * m.rate), signal);
    if (run !== m.run) return;
  }
  mixOp(m, () => { if (m.ms.readyState === 'open') m.ms.endOfStream(); });
}

/** Streams the mix from `fromS`; a failure that is not a newer run ends it in a network error, which CAF reports. */
function streamMix(m, fromS) {
  runMix(m, fromS).catch((e) => {
    if (e.name === 'AbortError' || m.closed) return;
    console.warn('[fliks-cast] mix', e);
    if (m.ms.readyState === 'open') m.ms.endOfStream('network');
  });
}

/** New gains apply from a block boundary just ahead of the playhead: what is buffered past it is remixed. */
function remix(m) {
  const media = findMediaElement();
  if (!media || !m.sb || !m.raw.length) return;
  const lead = Math.ceil((media.currentTime + MIX_REMIX_LEAD_S) * m.rate);
  const first = m.raw.findIndex((c) => c.start + c.raw[0].length / m.channels > lead);
  if (first < 0) return;
  const chunk = m.raw[first];
  const from = chunk.start + Math.max(0, Math.ceil((lead - chunk.start) / BLOCK) * BLOCK);
  mixOp(m, () => m.sb.remove(from / m.rate, Infinity));
  m.raw.slice(first).forEach((c) => {
    const skip = Math.max(0, from - c.start) * m.channels;
    if (skip < c.raw[0].length) appendMix(m, c.start + skip / m.channels, c.raw.map((r) => r.subarray(skip)));
  });
}

function closeMix(m) {
  if (m.closed) return;
  m.closed = true;
  m.run++;
  m.abort.abort();
  clearTimeout(m.remixTimer);
  URL.revokeObjectURL(m.url);
  if (activeMix === m) activeMix = null;
}

function startMix(id, sources, startS) {
  const ms = new MediaSource();
  const m = { id, ms, url: URL.createObjectURL(ms), sources, gains: sources.map((s) => +s.gain || 0), sb: null, ops: Promise.resolve(),
    abort: new AbortController(), run: 0, seq: 0, rate: 0, channels: 0, base: 0, end: 0, raw: [], closed: false, remixTimer: 0 };
  ms.addEventListener('sourceopen', () => streamMix(m, startS), { once: true });
  ms.addEventListener('sourceclose', () => closeMix(m));
  return m;
}

// A seek outside what is buffered (the played part is trimmed) or about to be starts the run again from there.
playerManager.addEventListener(cast.framework.events.EventType.SEEKING, () => {
  const m = activeMix;
  const media = findMediaElement();
  if (!m || !m.sb || !media) return;
  const t = media.currentTime;
  const { buffered } = m.sb;
  for (let i = 0; i < buffered.length; i++) if (t >= buffered.start(i) && t < buffered.end(i)) return;
  if (t >= m.end / m.rate && t <= m.end / m.rate + MIX_AHEAD_S) return;
  mixOp(m, () => m.sb.remove(0, Infinity));
  streamMix(m, t);
});

context.addCustomMessageListener(FLIKS_NAMESPACE, (event) => {
  const msg = event.data;
  if (!msg || msg.kind !== 'mix' || typeof msg.id !== 'string' || !Array.isArray(msg.sources)) return;
  mixSpecs.delete(msg.id);
  mixSpecs.set(msg.id, msg.sources);
  if (mixSpecs.size > 4) mixSpecs.delete(mixSpecs.keys().next().value);
  const m = activeMix;
  if (!m || m.id !== msg.id) return;
  if (msg.sources.some((s, i) => !m.sources[i] || s.url !== m.sources[i].url)) {
    m.sources = msg.sources;
    m.gains = msg.sources.map((s) => +s.gain || 0);
    const media = findMediaElement();
    if (m.sb) mixOp(m, () => m.sb.remove(0, Infinity));
    return streamMix(m, media ? media.currentTime : 0);
  }
  m.gains = msg.sources.map((s) => +s.gain || 0);
  // A slider sends a burst of levels: one remix for it.
  clearTimeout(m.remixTimer);
  m.remixTimer = setTimeout(() => remix(m), 120);
});

// --- Boot ---------------------------------------------------------------
//
// `useShakaForHls: true` makes CAF use Shaka for HLS — the same engine
// the Fliks web/Android paths use, so all three clients share buffering
// and ABR behaviour.
//
// The CAF idle timeout stays on: once the media ends the receiver closes instead of
// leaving the splash on the TV forever (a sender's next LOAD arrives within seconds).
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
options.useShakaForHls = true;
options.customNamespaces = {
  [FLIKS_NAMESPACE]: cast.framework.system.MessageType.JSON,
  [CAPS_NAMESPACE]: cast.framework.system.MessageType.JSON,
};
options.playbackConfig = new cast.framework.PlaybackConfig();
options.playbackConfig.autoResumeDuration = 5;
options.playbackConfig.shakaConfig = {
  // The engine anchors every tfdt; a playlist-grid realignment opens audio gaps that drift A/V.
  manifest: { hls: { ignoreManifestTimestampsInSegmentsMode: true } },
  ...(CAST_CMCD && { cmcd: { enabled: true, useHeaders: false } }),
};
options.supportedCommands = cast.framework.messages.Command.ALL_BASIC_MEDIA;
context.start(options);
console.log('[fliks-cast] context.start called');
