import { Injectable, effect, inject, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { CastService } from './cast.service';
import { CastSettingsService } from './cast-settings.service';
import { StreamingApiService } from './api/streaming-api.service';
import { SubtitlesApiService } from './api/subtitles-api.service';
import { AppSettingsService } from './app-settings.service';
import { buildSubtitleTracks } from '../utils/subtitle-tracks';
import { AuthService } from './auth.service';
import { DeviceProfile } from './browser-device-profile.service';
import { ENGINE_TRAITS, EngineKind } from './engine-traits';
import { ServerConfigService } from './server-config.service';
import { formatAudioLabel, formatSubtitleLabel, parseAudioIndex, SpriteMetadata } from '../utils/player.utils';
import { PlayerSettingsService } from './player-settings.service';
import { TrackManagerService } from './track-manager.service';
import { MediaService } from './api/media.service';
import { ToastService } from './toast.service';

export interface CastSubtitleOption {
  id: string;
  label: string;
  language: string;
  burnIn: boolean;
  forced?: boolean;
  castTrackId?: number;
  subtitleDbId?: number;
}

export interface CastAudioOption {
  id: string;
  label: string;
  language: string;
  /** Source-side title — must mirror the NAME attribute the backend writes
   *  in master.m3u8 (transcoding/master-playlist.ts). The receiver-side
   *  audio switch matches on this, so any divergence breaks switching. */
  name: string;
}

/** Build CastAudioOption[] from streamInfo audio streams. Single source of
 *  truth for both quickStart (cast from a detail page) and the player's
 *  castAudioOptions (cast in-progress). */
export function buildCastAudioOptions(
  audioStreams: { language?: string; title?: string; codec?: string; channels?: number }[] | undefined,
  translate: TranslateService,
): CastAudioOption[] {
  if (!audioStreams?.length) return [];
  return audioStreams.map((a, i) => {
    const lang = a.language ?? 'und';
    return {
      id: `audio-${i}`,
      label: formatAudioLabel(a, translate, i + 1),
      language: lang,
      name: a.title || lang,
    };
  });
}

export interface CastQualityOption {
  id: string;
  label: string;
  lowBandwidth?: boolean;
}

/** Filter a backend-authoritative quality list for Cast: drop the
 *  'original' rung (Cast forces transcode, never direct-streams) and
 *  cap by the user's Cast-side `maxQuality` preference. The cap is
 *  derived from the rung id itself (`parseInt('Np')`) so adding a new
 *  rung server-side requires no client change. */
export function buildCastQualityOptions(
  qualities:
    | { id: string; label: string; height: number; lowBandwidth?: boolean }[]
    | undefined,
  maxQuality: string | undefined,
): CastQualityOption[] {
  if (!qualities?.length) return [];
  const heightCap =
    maxQuality && maxQuality !== 'original'
      ? parseInt(maxQuality, 10) || Infinity
      : Infinity;
  return qualities
    .filter(q => q.id !== 'original' && q.height <= heightCap)
    .map(q => ({ id: q.id, label: q.label, lowBandwidth: q.lowBandwidth }));
}

interface SubtitleInfo {
  id: string;
  label: string;
  language: string;
  burnIn: boolean;
  subtitleDbId?: number;
  url: string;
  forced?: boolean;
}

/**
 * Global service managing Cast stream state.
 * Extracted from PlayerComponent so the Cast overlay can work independently.
 */
@Injectable({ providedIn: 'root' })
export class CastPlayerService {
  private readonly cast = inject(CastService);
  private readonly castSettings = inject(CastSettingsService);
  private readonly streamingApi = inject(StreamingApiService);
  private readonly subtitlesApi = inject(SubtitlesApiService);
  private readonly appSettings = inject(AppSettingsService);
  private readonly authService = inject(AuthService);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly playerSettings = inject(PlayerSettingsService);
  private readonly trackManager = inject(TrackManagerService);
  private readonly mediaService = inject(MediaService);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);

  /** Chromecast profile, derived from the receiver-probed MSE codec list
   *  (see `probeReceiverCapabilities`). `videoCodecs: []` keeps every Cast
   *  on the transcode path so the backend ladder drives quality/ABR; the
   *  surround output codec is picked in stream-builder from the audio
   *  codecs we list here (priority EAC-3 > AC-3 > AAC).
   *
   *  Without cached caps (first cast to a new device, or older receiver
   *  that doesn't answer the probe), we fall back to AAC-only stereo — a
   *  Cast generation we don't recognise is safer downmixed than failing
   *  to play. */
  getCastDeviceProfile(): DeviceProfile {
    const cs = this.castSettings.get();
    const maxChannels = cs.audioChannels ?? 2;

    // Pull the receiver's probed capabilities for the currently connected
    // device (cached from a previous session, or just-populated by an
    // in-flight probe). Default to AAC-only when we have nothing.
    const deviceName = this.currentDeviceName();
    const caps = deviceName
      ? this.castSettings.getDeviceCapabilities(deviceName)
      : null;
    const receiverAudio = caps?.audioCodecs ?? ['aac'];

    // Filter against codecs the backend can actually emit (the transcoder
    // produces AAC, AC-3, or EAC-3) and against the channel preference.
    // EAC-3 is intentionally NOT exposed here even when the receiver
    // claims `audio/mp4; codecs="ec-3"` is supported via MSE — multiple
    // Android TV / Cast firmwares advertise it but then fail at chunk
    // append or load. AC-3 is the safe surround target across the entire
    // Cast generation lineup. Revisit if we can confirm EAC-3 actually
    // works end-to-end on a given receiver via chrome://inspect logs.
    const surroundOk = maxChannels >= 6;
    const allowedAudio = receiverAudio.filter((c) => {
      if (c === 'aac' || c === 'aac-he') return true;
      if (c === 'ac3') return surroundOk;
      return false;
    });
    // Normalise to the codec strings stream-builder compares against.
    const audioCodecs = allowedAudio.map((c) =>
      c === 'aac-he' ? 'aac' : c,
    );

    return {
      directPlayProfiles: [
        { containers: ['hls'], videoCodecs: [], audioCodecs },
      ],
      codecConditions: [],
      maxStreamingBitrate: 20_000_000,
      maxAudioChannels: maxChannels,
      supportsHdr: cs.hdr ?? false,
      deviceType: 'desktop',
      deviceName: deviceName ? `Chromecast — ${deviceName}` : 'Chromecast',
      // HLS-TS is disabled on Cast in every scenario. Originally
      // introduced as a workaround for the fMP4 + AAC encoder priming
      // desync (Shaka ignores the init segment `edts/elst` atom), but it
      // breaks mid-file resume (Shaka error 3016) and prevents AC-3 / EAC-3
      // surround paths (Shaka can't transmux Dolby in TS → MSE). fMP4
      // works for every codec path we currently emit. The `useTs` flag
      // and its backend plumbing are kept as dead code so we can flip
      // back later without re-doing the plumbing.
      useTs: false,
      // The Cast receiver runs Shaka, which fetches seg-0 on a load-then-seek,
      // so keep the backend's seg-0 early-start companion for resumes. The CAST
      // row sets only `probesSegZero`, leaving useTsOnSingleAudio /
      // supportsHlsSubtitles / supportsDirectPlay undefined on the wire.
      ...ENGINE_TRAITS[EngineKind.CAST],
    };
  }

  /** Friendly name of the currently connected Cast device, or null when
   *  no session is active. Used as the cache key for receiver-probed
   *  capabilities. */
  private currentDeviceName(): string | null {
    try {
      const session = (window as any).cast?.framework?.CastContext
        ?.getInstance?.()
        ?.getCurrentSession?.();
      return session?.getCastDevice?.()?.friendlyName ?? null;
    } catch {
      return null;
    }
  }

  /** Ask the receiver which audio/video codecs `MediaSource.isTypeSupported`
   *  accepts. The receiver answers on the same `urn:x-cast:app.fliks.caps`
   *  namespace. Result is cached per device so only the first session to
   *  a new Cast pays the round-trip; subsequent sessions read directly
   *  from {@link CastSettingsService.getDeviceCapabilities}. */
  private async probeReceiverCapabilities(): Promise<void> {
    const session = (window as any).cast?.framework?.CastContext
      ?.getInstance?.()
      ?.getCurrentSession?.();
    if (!session) {
      console.log('[fliks-cast/sender] probe skipped: no session');
      return;
    }
    const deviceName = session.getCastDevice?.()?.friendlyName;
    if (!deviceName) {
      console.log('[fliks-cast/sender] probe skipped: no friendlyName');
      return;
    }
    // Skip if we already have caps for this device — the probe is idempotent
    // but each round-trip is ~150–300 ms and slows the first loadMedia.
    const cached = this.castSettings.getDeviceCapabilities(deviceName);
    if (cached) {
      console.log('[fliks-cast/sender] probe skipped (cached):', deviceName, cached);
      return;
    }

    const namespace = 'urn:x-cast:app.fliks.caps';
    console.log('[fliks-cast/sender] probing', deviceName, 'on', namespace);
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (reason: string) => {
        if (settled) return;
        settled = true;
        console.log('[fliks-cast/sender] probe finished:', reason);
        try { session.removeMessageListener?.(namespace, listener); } catch { /* noop */ }
        resolve();
      };
      const listener = (_ns: string, raw: string) => {
        console.log('[fliks-cast/sender] probe reply raw:', raw);
        try {
          const data = JSON.parse(raw);
          if (data?.type !== 'caps') return;
          this.castSettings.setDeviceCapabilities(deviceName, {
            audioCodecs: Array.isArray(data.audioCodecs) ? data.audioCodecs : [],
            videoCodecs: Array.isArray(data.videoCodecs) ? data.videoCodecs : [],
          });
        } catch (err) {
          console.warn('[fliks-cast/sender] probe parse error:', err);
        }
        finish('reply');
      };
      try {
        session.addMessageListener(namespace, listener);
        session.sendMessage(namespace, JSON.stringify({ type: 'probe' }));
      } catch (err) {
        console.warn('[fliks-cast/sender] sendMessage threw:', err);
        finish('exception');
        return;
      }
      // 2 s ceiling — older receivers that don't implement the namespace
      // won't answer, falling back to whatever capabilities (or absence)
      // the cache already has.
      setTimeout(() => finish('timeout'), 2000);
    });
  }

  // Sprite preview
  readonly spriteUrl = signal<string | null>(null);
  readonly spriteMetadata = signal<SpriteMetadata | null>(null);

  // Media info
  readonly mediaFileId = signal(0);
  readonly mediaId = signal(0);
  readonly episodeId = signal<number | undefined>(undefined);
  readonly mediaTitle = signal('');
  readonly episodeTitle = signal('');
  readonly fanartUrl = signal<string | null>(null);
  readonly playbackMode = signal<'direct' | 'remux' | 'transcode'>('transcode');

  // Options
  readonly availableSubtitles = signal<CastSubtitleOption[]>([]);
  readonly availableQualities = signal<CastQualityOption[]>([]);
  readonly availableAudioTracks = signal<CastAudioOption[]>([]);

  // Active selections
  readonly activeQualityId = signal('auto');
  readonly activeSubtitleId = signal<string | null>(null);
  readonly activeAudioTrackId = signal<string | null>(null);

  // Internal state
  private activeBurnInId: number | null = null;
  private activeAudioStreamIndex: number | undefined;
  private subtitleInfos: SubtitleInfo[] = [];
  private saveInterval: ReturnType<typeof setInterval> | null = null;

  /** Whether a Cast session is actively playing media (not just connected). */
  readonly hasMedia = signal(false);
  /** Whether the Cast overlay card is expanded. */
  readonly expanded = signal(false);
  /** Server-issued live session id for the currently-playing Cast stream.
   *  Distinct from the sender's local sid: the receiver's profile (cast
   *  codec capabilities) and the resulting transcode session live under
   *  this id, so the sender heartbeats it instead of its local sid while
   *  the cast is connected. */
  readonly liveSessionId = signal<string | null>(null);

  /**
   * Initialize a Cast session with media data from the player.
   * Called by the PlayerComponent when Cast is active on init or toggled on.
   */
  startCast(opts: {
    mediaFileId: number;
    mediaId: number;
    episodeId?: number;
    mediaTitle: string;
    episodeTitle: string;
    fanartUrl: string | null;
    playbackMode: 'direct' | 'remux' | 'transcode';
    subtitles: SubtitleInfo[];
    qualities: CastQualityOption[];
    audioTracks: CastAudioOption[];
    activeQualityId: string;
    activeSubtitleId: string | null;
    activeAudioTrackId: string | null;
    activeBurnInId: number | null;
    activeAudioStreamIndex: number | undefined;
  }) {
    this.mediaFileId.set(opts.mediaFileId);
    this.mediaId.set(opts.mediaId);
    this.episodeId.set(opts.episodeId);
    this.mediaTitle.set(opts.mediaTitle);
    this.episodeTitle.set(opts.episodeTitle);
    this.fanartUrl.set(opts.fanartUrl ?? null);
    this.playbackMode.set(opts.playbackMode);
    this.subtitleInfos = opts.subtitles;
    this.activeQualityId.set(opts.activeQualityId);
    this.activeSubtitleId.set(opts.activeSubtitleId);
    this.activeAudioTrackId.set(opts.activeAudioTrackId);
    this.activeBurnInId = opts.activeBurnInId;
    this.activeAudioStreamIndex = opts.activeAudioStreamIndex;

    // Build cast subtitle options (with trackId mapping)
    let trackId = 1;
    this.availableSubtitles.set(opts.subtitles.map(s => ({
      id: s.id,
      label: s.label,
      language: s.language,
      burnIn: s.burnIn,
      forced: s.forced,
      subtitleDbId: s.subtitleDbId,
      castTrackId: s.burnIn ? s.subtitleDbId : trackId++,
    })));
    this.availableQualities.set(opts.qualities);
    this.availableAudioTracks.set(opts.audioTracks);
    this.hasMedia.set(true);
    this.startPositionSaving();
    this.loadSpriteMetadata(opts.mediaFileId);
  }

  /** Clear Cast media state (on disconnect/stop). Saves position first
   *  and kills the backend transcode session so its ffmpeg stops; without
   *  this the session lingers until SESSION_TIMEOUT_MS, holding HW
   *  encoder slots and disk cache. */
  private disconnectGrace: ReturnType<typeof setTimeout> | null = null;
  private static readonly DISCONNECT_GRACE_MS = 45_000;

  clear() {
    if (this.disconnectGrace) {
      clearTimeout(this.disconnectGrace);
      this.disconnectGrace = null;
    }
    const mfId = this.mediaFileId();
    const castSid = this.liveSessionId();
    this.saveCastPosition(); // Save final position before clearing
    this.stopPositionSaving();
    if (mfId) {
      // Sid-scoped kill so a sender that's still watching locally on a
      // different profile isn't torn down by the cast stop.
      this.streamingApi.stopSessions(mfId, castSid ?? undefined).catch(() => {});
    }
    this.liveSessionId.set(null);
    this.hasMedia.set(false);
    this.expanded.set(false);
    this.mediaFileId.set(0);
    this.spriteUrl.set(null);
    this.spriteMetadata.set(null);
  }

  constructor() {
    // Tear down when the cast session drops, but debounce it: a sender blip
    // (Wi-Fi roam, sleep) drops the connection while the TV keeps playing, and
    // clearing here would 410 it. CAF auto-rejoins (ORIGIN_SCOPED), so cancel
    // the teardown on reconnect; a real stop just clears a bit later.
    effect(() => {
      const connected = this.cast.isConnected();
      if (connected) {
        if (this.disconnectGrace) {
          clearTimeout(this.disconnectGrace);
          this.disconnectGrace = null;
        }
        return;
      }
      if (this.hasMedia() && !this.disconnectGrace) {
        this.disconnectGrace = setTimeout(() => {
          this.disconnectGrace = null;
          if (!this.cast.isConnected() && this.hasMedia()) this.clear();
        }, CastPlayerService.DISCONNECT_GRACE_MS);
      }
    });
    // On every session connect, ask the receiver which audio/video codecs
    // its MediaSource accepts and cache the answer by device name. The
    // probe is a no-op when the cache already covers this device.
    effect(() => {
      if (this.cast.isConnected()) {
        void this.probeReceiverCapabilities();
      }
    });
    // Receiver reported a recoverable playback error (session GC'd → 410 on
    // the next segment). Re-establish a fresh stream and resume. Root
    // singleton, so the subscription lives for the app's lifetime.
    this.cast.playbackError$.subscribe(({ position }) => {
      void this.recoverFromCastError(position);
    });
  }

  /** Recover from a fatal receiver error by reloading with a fresh sid at
   *  the last known position. Throttled so a genuinely broken stream
   *  (deleted file, lost ACL) can't drive an endless reload loop: isolated
   *  errors recover freely, but three inside 30 s give up with a toast. */
  private recoverAttempts = 0;
  private lastRecoverAt = 0;

  private async recoverFromCastError(position?: number): Promise<void> {
    if (!this.hasMedia()) return;
    const now = Date.now();
    if (now - this.lastRecoverAt > 30_000) this.recoverAttempts = 0;
    if (this.recoverAttempts >= 3) {
      this.toast.error(this.translate.instant('cast.error.recovery_failed'));
      return;
    }
    this.recoverAttempts++;
    this.lastRecoverAt = now;
    const pos = position && position > 0 ? position : this.cast.currentTime();
    try {
      await this.reloadCastStream(pos);
    } catch {
      /* a still-broken stream re-fires the error, subject to the throttle */
    }
  }

  /**
   * Reload the Cast stream after a quality / audio / burn-in change.
   * Drops any in-flight ffmpeg session before re-spawning, since the new
   * audio/burn-in context wouldn't be picked up by an existing session
   * (transcoding.service only auto-replaces on quality change).
   */
  async reloadCastStream(positionOverride?: number, autoplay = true) {
    const mfId = this.mediaFileId();
    if (!mfId) return;

    // Scope the stop to the Cast session's own sid so a concurrent local
    // session on the same file (another profile/device) is not torn down too.
    await this.streamingApi.stopSessions(mfId, this.liveSessionId() ?? undefined).catch(() => {});

    const currentPos = positionOverride ?? this.cast.currentTime();
    const audioIdx = this.activeAudioStreamIndex
      ?? parseAudioIndex(this.activeAudioTrackId() ?? 'audio-0');
    // The cast dropdown only contains concrete transcode rungs, so the
    // active id is the rung name to send to the backend.
    const transcodeQuality = this.activeQualityId();

    // Parallel: playback-info (triggers backend prewarm) + cast token fetch.
    const castProfile = this.getCastDeviceProfile();
    const [pi, castInfo] = await Promise.all([
      this.streamingApi.getPlaybackInfo(
        mfId, castProfile, this.activeBurnInId ?? undefined, audioIdx,
        transcodeQuality, Math.floor(currentPos),
      ),
      this.authService.getCastInfo(),
    ]);

    await this.dispatchLoad(mfId, pi, currentPos, transcodeQuality, castInfo, autoplay);
  }

  /**
   * Build the cast URL from a playback-info response and dispatch loadMedia.
   * Shared between quickStart (initial cast) and reloadCastStream (changes).
   */
  private async dispatchLoad(
    mfId: number,
    pi: { playMethod: string; sessionId?: string },
    currentPos: number,
    transcodeQuality: string | undefined,
    castInfo: { token: string; streamBaseUrl: string },
    autoplay: boolean,
  ) {
    const castMode: 'direct' | 'remux' | 'transcode' =
      pi.playMethod === 'DirectPlay' ? 'direct' :
      pi.playMethod === 'DirectStream' ? 'remux' : 'transcode';
    this.playbackMode.set(castMode);

    const { token: castToken, streamBaseUrl } = castInfo;
    this.cast.setCastStreamBase(streamBaseUrl);
    const fromServer = streamBaseUrl.replace(/\/+$/, '');
    const lanUrl =
      fromServer ||
      (this.serverConfig.isNative
        ? this.serverConfig.serverUrl()
        : window.location.origin);

    // Route Cast through master.m3u8 (same as desktop/Android) so the
    // backend's tracker sets useExtXMedia for multi-audio renditions —
    // bypassing master breaks `init_N.mp4` resolution + drops audio entirely
    // when var_stream_map is used.
    let castUrl: string;
    let contentType: string;
    const tokenQ = encodeURIComponent(castToken);
    const startAtParam = `&startAt=${Math.floor(currentPos)}`;
    const sidParam = pi.sessionId
      ? `&sid=${encodeURIComponent(pi.sessionId)}`
      : '';
    if (castMode === 'direct') {
      castUrl = this.streamingApi.getAbsoluteStreamUrl(
        mfId,
        castToken,
        pi.sessionId,
      );
      contentType = 'video/mp4';
    } else if (castMode === 'remux') {
      castUrl = `${lanUrl}/api/stream/${mfId}/master.m3u8?token=${tokenQ}${sidParam}&remux=1${startAtParam}`;
      contentType = 'application/x-mpegurl';
    } else {
      const q = transcodeQuality ?? '1080p';
      castUrl = `${lanUrl}/api/stream/${mfId}/master.m3u8?token=${tokenQ}${sidParam}&startQuality=${q}${startAtParam}`;
      contentType = 'application/x-mpegurl';
    }

    // Stash the Cast live-session id so the sender's heartbeat loop
    // (`savePosition` in the local player) keeps the receiver's
    // session warm instead of beating the now-paused browser session.
    this.liveSessionId.set(pi.sessionId ?? null);

    const subtitles = this.subtitleInfos
      .filter(s => !s.burnIn && s.subtitleDbId)
      .map(s => ({
        url: s.id.startsWith('ext-')
          ? this.streamingApi.getAbsoluteSubtitleUrl(mfId, s.subtitleDbId!, castToken)
          : this.streamingApi.getAbsoluteEmbeddedSubtitleUrl(mfId, parseInt(s.id.replace('emb-', ''), 10), castToken),
        language: s.language,
        label: s.label,
      }));

    const activeSubId = this.activeSubtitleId();
    let activeSubtitleTrackId: number | undefined;
    if (activeSubId) {
      const allNonBurnIn = this.subtitleInfos.filter(s => !s.burnIn && s.subtitleDbId);
      const idx = allNonBurnIn.findIndex(s => s.id === activeSubId);
      if (idx >= 0) activeSubtitleTrackId = idx + 1;
    }

    // Show the loading sweep immediately rather than waiting for the first
    // receiver state tick; the player-state feed reconciles it once playback
    // (or a rebuffer) actually starts.
    this.cast.buffering.set(true);

    await this.cast.loadMedia({
      url: castUrl,
      contentType,
      title: this.mediaTitle(),
      subtitle: this.episodeTitle() || undefined,
      posterUrl: this.fanartUrl() ?? undefined,
      currentTime: currentPos,
      subtitles,
      activeSubtitleTrackId,
      mediaId: this.mediaId(),
      episodeId: this.episodeId(),
      autoplay,
    });
  }

  async changeQuality(qualityId: string) {
    this.activeQualityId.set(qualityId);
    await this.reloadCastStream();
  }

  async changeAudio(audioIndex: number) {
    this.activeAudioStreamIndex = audioIndex;

    const trackId = `audio-${audioIndex}`;
    this.trackManager.saveAudioSelection(
      trackId, this.availableAudioTracks(), this.mediaId(), 0,
    );
    this.activeAudioTrackId.set(trackId);

    // Fast path: switch the active audio rendition via EditTracksInfoRequest
    // (web) or RemoteMediaClient.setActiveMediaTracks (native) on the
    // standard media bus. Sub-100ms swap, no ffmpeg restart. Falls through
    // to a full reload when the receiver hasn't published the rendition yet.
    const audio = this.availableAudioTracks()[audioIndex];
    if (audio && (await this.cast.setActiveAudioLanguage(audio.language, audio.name))) {
      return;
    }

    await this.reloadCastStream();
  }

  private startPositionSaving() {
    this.stopPositionSaving();
    this.saveInterval = setInterval(() => this.saveCastPosition(), 10_000);
  }

  private stopPositionSaving() {
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = null;
    }
  }

  private async saveCastPosition() {
    const mfId = this.mediaFileId();
    const mId = this.mediaId();
    if (!mfId || !mId) return;
    const pos = this.cast.currentTime();
    const dur = this.cast.duration();
    if (!pos || pos < 1) return;
    try {
      // Carry the Cast live-session id so the backend refreshes its
      // lastBeat. Once the player page is gone this loop is the only
      // keep-alive for the receiver's session; without the sid the
      // backend GCs it after the ttl and 410s the next segment, which
      // the receiver has no way to recover from.
      const sid = this.liveSessionId();
      const heartbeat = sid
        ? {
            sessionId: sid,
            state: (this.cast.isPaused() ? 'paused' : 'playing') as
              | 'paused'
              | 'playing',
          }
        : {};
      const response = await this.streamingApi.updatePlaybackState(mId, {
        positionSeconds: pos,
        durationSeconds: dur || 0,
        mediaFileId: mfId,
        episodeId: this.episodeId(),
        ...heartbeat,
      });
      // Backend lost the session (its keep-alive lapsed, a restart, …).
      // The receiver can't self-heal a session_expired, so re-issue
      // playback-info and reload the stream with a fresh sid.
      // Preserve the receiver's pause state across an auto-recovery reload — a
      // paused cast whose session was reaped (missed heartbeats) must not be
      // force-resumed by the reload's default autoplay.
      if (response?.sessionLost)
        await this.reloadCastStream(pos, !this.cast.isPaused());
    } catch { /* ignore */ }
  }

  /** Find the subtitle matching the user's remembered language+type for this media. */
  private resolveRememberedSubtitleId(
    mediaId: number,
    subtitles: SubtitleInfo[],
  ): string | null {
    const settings = this.playerSettings.get();
    if (!settings.rememberSubtitleSelections || !mediaId) return null;
    const saved = this.playerSettings.getRememberedSubtitleTrack(mediaId);
    if (!saved || saved === 'off') return null;
    const [savedLang, savedType] = saved.split(':');
    const wantForced = savedType === 'forced';
    const match =
      subtitles.find((s) => !s.burnIn && s.language === savedLang && !!s.forced === wantForced)
      ?? subtitles.find((s) => !s.burnIn && s.language === savedLang && !s.forced);
    return match?.id ?? null;
  }

  saveSubtitleSelection(language: string | null, forced = false) {
    const mId = this.mediaId();
    if (mId) this.trackManager.saveSubtitleSelection(mId, language, forced);
  }

  private async loadSpriteMetadata(mediaFileId: number) {
    this.spriteUrl.set(null);
    this.spriteMetadata.set(null);
    try {
      const url = this.streamingApi.getThumbnailMetadataUrl(mediaFileId);
      const res = await fetch(url);
      if (!res.ok) return;
      const meta: SpriteMetadata = await res.json();
      this.spriteMetadata.set(meta);
      this.spriteUrl.set(this.streamingApi.getThumbnailSpriteUrl(mediaFileId));
    } catch { /* sprite not available */ }
  }

  async changeBurnIn(subtitleDbId: number | null) {
    if (this.activeBurnInId === subtitleDbId) return;
    this.activeBurnInId = subtitleDbId;
    await this.reloadCastStream();
  }

  /**
   * Quick-start Cast from a detail page (no player needed).
   * Fetches playbackInfo, subtitles, builds options, and starts streaming.
   */
  async quickStart(opts: {
    mediaFileId: number;
    mediaId: number;
    episodeId?: number;
    title: string;
    episodeTitle?: string;
    fanartUrl?: string | null;
    streamInfo?: any;
    startTime?: number;
  }) {
    // Phase 1 — parallelize every fetch that doesn't depend on streamInfo
    // resolution. Saves ~3 sequential round-trips on cold cast.
    const needsMediaFetch = !opts.streamInfo;
    const needsSavedState = opts.startTime == null;
    const [mediaResult, subsResult, savedState, castInfo] = await Promise.all([
      needsMediaFetch
        ? this.mediaService.getOne(opts.mediaId).catch(() => null)
        : Promise.resolve(null),
      this.subtitlesApi.getForMedia(opts.mediaId).catch(() => [] as any[]),
      needsSavedState
        ? this.streamingApi
            .getPlaybackState(opts.mediaId, opts.episodeId)
            .catch(() => null)
        : Promise.resolve(null),
      this.authService.getCastInfo(),
    ]);

    let streamInfo = opts.streamInfo;
    let fanartUrl = opts.fanartUrl ?? null;
    if (mediaResult) {
      const file = mediaResult.files?.find((f: any) => f.id === opts.mediaFileId);
      streamInfo = file?.streamInfo;
      if (!fanartUrl && mediaResult.fanartUrl) fanartUrl = mediaResult.fanartUrl;
    }
    if (fanartUrl) fanartUrl = this.serverConfig.resolveUrl(fanartUrl);

    // Resolve start position: explicit > saved playback state > 0
    let startTime = opts.startTime;
    if (startTime == null && savedState && !savedState.completed && savedState.positionSeconds > 10) {
      startTime = savedState.positionSeconds;
    }
    startTime ??= 0;

    const audioStreams: { language?: string }[] = streamInfo?.audio ?? [];
    const audioIndex = this.playerSettings.resolveAudioStreamIndex(
      opts.mediaFileId, audioStreams, opts.mediaId,
    );

    // Build subtitle list from the parallel fetch (shared with the player).
    await this.appSettings.ensureLoaded();
    const subtitleInfos: SubtitleInfo[] = buildSubtitleTracks(
      subsResult,
      opts.mediaFileId,
      { hideBurnIn: this.appSettings.hideBurnInSubtitles() },
    ).map((t) => ({
      id: t.key,
      label: formatSubtitleLabel(t, this.translate),
      language: t.language,
      burnIn: t.kind === 'embedded' && t.isImage,
      subtitleDbId: t.subtitleId,
      url:
        t.kind === 'external'
          ? this.streamingApi.getSubtitleUrl(opts.mediaFileId, t.subtitleId)
          : t.isImage
            ? ''
            : this.streamingApi.getEmbeddedSubtitleUrl(opts.mediaFileId, t.streamIndex!),
      forced: t.forced,
    }));

    const audioTracks = buildCastAudioOptions(streamInfo?.audio, this.translate);

    // Phase 2 — single playback-info call. We pass the user's cast cap as
    // startQuality so the backend pre-spawns ffmpeg at the right rung; the
    // backend snaps it to whatever the source can actually serve.
    const cs = this.castSettings.get();
    const startQuality = cs.maxQuality === 'original' ? '1080p' : cs.maxQuality;
    const pi = await this.streamingApi.getPlaybackInfo(
      opts.mediaFileId, this.getCastDeviceProfile(),
      undefined, audioIndex, startQuality, Math.floor(startTime),
    );

    // Build the dropdown list from the backend-authoritative qualities,
    // capped by the user's cast preference. Active pick defaults to the
    // first (highest) rung in the filtered list.
    const qualities = buildCastQualityOptions(pi.qualities, cs.maxQuality);
    const activeQualityId = qualities[0]?.id ?? '1080p';

    this.startCast({
      mediaFileId: opts.mediaFileId,
      mediaId: opts.mediaId,
      episodeId: opts.episodeId,
      mediaTitle: opts.title,
      episodeTitle: opts.episodeTitle ?? '',
      fanartUrl,
      playbackMode: 'transcode',
      subtitles: subtitleInfos,
      qualities,
      audioTracks,
      activeQualityId,
      activeSubtitleId: this.resolveRememberedSubtitleId(opts.mediaId, subtitleInfos),
      activeAudioTrackId: audioIndex != null ? `audio-${audioIndex}` : (audioTracks[0]?.id ?? null),
      activeBurnInId: null,
      activeAudioStreamIndex: audioIndex,
    });

    await this.dispatchLoad(opts.mediaFileId, pi, startTime, activeQualityId, castInfo, true);
  }
}
