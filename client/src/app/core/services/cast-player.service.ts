import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { CastService } from './cast.service';
import type { QoeSample } from './playback-engine';
import { hasQoeData } from './playback-engine/playback-engine';
import { QoeReporter, newPlaybackId } from './qoe-reporter.service';
import type { QoeRecoveryReason } from './api/qoe-api.service';
import { CastDeviceCapabilities, CastSettingsService } from './cast-settings.service';
import { StreamingApiService, type PlayMethod } from './api/streaming-api.service';
import { SubtitlesApiService, type SubtitleFileRow } from './api/subtitles-api.service';
import { AppSettingsService } from './app-settings.service';
import { buildSubtitleTracks } from '../utils/subtitle-tracks';
import { normalizeLangCode } from '../utils/language.utils';
import { AuthService } from './auth.service';
import { CodecCondition, DeviceProfile } from './browser-device-profile.service';
import {
  CAST_CUSTOM_DATA_BUDGET,
  encodeEdlWire,
  jsonBytes,
  muteRangesOf,
  type EdlRange,
} from '../utils/edl-policy';
import { ENGINE_TRAITS, EngineKind } from './engine-traits';
import { ServerConfigService } from './server-config.service';
import { formatAudioParts, formatAudioLabel, parseAudioIndex, playbackModeOf, SpriteMetadata, type PlaybackMode } from '../utils/player.utils';
import {
  PlayerSettingsService,
  type AudioStreamChoice,
} from './player-settings.service';
import { TrackManagerService, launchPickFor, type LaunchTracks, type SubtitleOption } from './track-manager.service';
import { MediaService } from './api/media.service';
import { ToastService } from './toast.service';

export interface CastSubtitleOption {
  id: string;
  label: string;
  /** Language on the first line, format and flags on the second. */
  head?: string;
  sub?: string;
  language: string;
  languageTag?: string | null;
  burnIn: boolean;
  forced?: boolean;
  hearingImpaired?: boolean;
  /** Bitmap track (PGS/VOBSUB): the receiver can't draw it, so it is always burned in. */
  isImage?: boolean;
  /** Burn-in: the subtitle's DB id. Otherwise its 1-based position in the LOAD's track list. */
  castTrackId?: number;
  subtitleDbId?: number;
}

export interface CastAudioOption {
  id: string;
  label: string;
  language: string;
  /** Language on the first line, codec and channels on the second. */
  head: string;
  sub: string;
  /** Must equal the unique NAME the backend writes in master.m3u8 (see
   *  {@link uniqueAudioNames}): the receiver-side audio switch matches on it. */
  name: string;
  /** What the remembered selection matches on (`rememberedAudioKey`). */
  languageTag?: string;
  commentary?: boolean;
  audioDescription?: boolean;
  channels?: number;
}

/** The NAME each rendition gets in master.m3u8, mirroring `buildUniqueAudioNames`
 *  (backend hls-variant-ladder.ts): `#2`, `#3`… keep same-named tracks distinct. */
function uniqueAudioNames(streams: { language?: string; title?: string }[]): string[] {
  const seen = new Map<string, number>();
  return streams.map((s) => {
    const base = s.title || s.language || 'und';
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} #${count}`;
  });
}

/** Single source of truth for quickStart and the player's castAudioOptions. */
export function buildCastAudioOptions(
  audioStreams: (AudioStreamChoice & { title?: string; languageTag?: string; codec?: string })[] | undefined,
  translate: TranslateService,
): CastAudioOption[] {
  if (!audioStreams?.length) return [];
  const names = uniqueAudioNames(audioStreams);
  return audioStreams.map((a, i) => {
    const lang = a.language ?? 'und';
    const parts = formatAudioParts(a, translate, i + 1);
    return {
      id: `audio-${i}`,
      label: formatAudioLabel(a, translate, i + 1),
      head: parts.head,
      sub: parts.sub,
      language: normalizeLangCode(lang),
      name: names[i],
      languageTag: a.languageTag,
      commentary: a.commentary,
      audioDescription: a.audioDescription,
      channels: a.channels,
    };
  });
}

export interface CastQualityOption {
  id: string;
  label: string;
  lowBandwidth?: boolean;
}

/** Drops 'original' (Cast always transcodes) and caps by `maxQuality`, parsed from the rung id so new rungs need no client change. */
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

/** The burn-in a Cast LOAD needs for `activeId`. The receiver can't draw bitmap
 *  subtitles, so every image track is burned in, whatever the local device renders itself. */
export function castBurnInId(subtitles: SubtitleOption[], activeId: string | null): number | null {
  const active = subtitles.find((s) => s.id === activeId);
  return active?.isImage ? (active.subtitleDbId ?? null) : null;
}

/** Everything {@link CastPlayerService} needs to take a session over again. */
interface CastResumeState {
  mediaFileId: number;
  mediaId: number;
  episodeId: number | undefined;
  mediaTitle: string;
  episodeTitle: string;
  fanartUrl: string | null;
  playbackMode: PlaybackMode;
  liveSessionId: string | null;
  playbackId?: string | null;
  availableSubtitles: CastSubtitleOption[];
  availableQualities: CastQualityOption[];
  availableAudioTracks: CastAudioOption[];
  activeQualityId: string;
  activeSubtitleId: string | null;
  activeAudioTrackId: string | null;
  activeBurnInId: number | null;
}

/** Receiver probe version that reports the 10-bit and HDR fields; an older cached answer is re-probed. */
const RECEIVER_CAPS_VERSION = 2;

/** A receiver sample older than this is dropped (receiver gone or not pushing). */
const QOE_STALE_MS = 30_000;
type ReceiverSample = NonNullable<ReturnType<CastService['receiverQoe']>>;

/** A sample of the previous load, still in flight when a reload minted a new sid. */
const fromOtherLoad = (q: ReceiverSample, sid: string | null) => !!q.sid && q.sid !== sid;

/** Global Cast stream state, so the Cast overlay works independently of PlayerComponent. */
@Injectable({ providedIn: 'root' })
export class CastPlayerService {
  private readonly cast = inject(CastService);
  private readonly castSettings = inject(CastSettingsService);
  private readonly streamingApi = inject(StreamingApiService);
  private readonly qoeReporter = inject(QoeReporter);
  private readonly subtitlesApi = inject(SubtitlesApiService);
  private readonly appSettings = inject(AppSettingsService);
  private readonly authService = inject(AuthService);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly playerSettings = inject(PlayerSettingsService);
  private readonly trackManager = inject(TrackManagerService);
  private readonly mediaService = inject(MediaService);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);

  /** Profile from the receiver-probed MSE codecs. A receiver that predates probe v2 (or no probe) keeps
   * `videoCodecs` empty, so the engine transcodes to H.264 SDR; without caps audio is AAC-only stereo. */
  getCastDeviceProfile(): DeviceProfile {
    const cs = this.castSettings.get();
    const maxChannels = cs.audioChannels ?? 2;

    const deviceName = this.currentDeviceName();
    const caps = deviceName
      ? this.castSettings.getDeviceCapabilities(deviceName)
      : null;
    const receiverAudio = caps?.audioCodecs ?? ['aac'];

    // EAC-3 is not exposed: several Cast/Android TV firmwares advertise it via MSE but fail at chunk append; AC-3 is the safe surround target.
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

    const { videoCodecs, codecConditions, hdrCapable } = this.receiverVideo(caps);

    return {
      directPlayProfiles: [
        { containers: ['hls'], videoCodecs, audioCodecs },
      ],
      codecConditions,
      maxStreamingBitrate: 20_000_000,
      maxAudioChannels: maxChannels,
      supportsHdr: (cs.hdr ?? false) && hdrCapable,
      deviceType: 'desktop',
      deviceName: deviceName ? `Chromecast - ${deviceName}` : 'Chromecast',
      // HLS-TS stays off on Cast: it breaks mid-file resume (Shaka 3016) and Shaka can't transmux Dolby from TS.
      useTs: false,
      // The Cast receiver runs Shaka (seg-0 fetched on load-then-seek, real ABR); CAST traits leave the other flags undefined.
      ...ENGINE_TRAITS[EngineKind.CAST],
    };
  }

  /** Conservative video side of the profile: only a v2 receiver, and only what its MSE reports; levels
   * are capped below what receivers over-report. HDR needs a 10-bit decoder and an HDR display. */
  private receiverVideo(caps: CastDeviceCapabilities | null) {
    const none = { videoCodecs: [] as string[], codecConditions: [] as CodecCondition[], hdrCapable: false };
    if (!caps || (caps.v ?? 1) < RECEIVER_CAPS_VERSION || !caps.videoCodecs.includes('h264')) return none;
    const videoCodecs = ['h264', 'avc1'];
    const codecConditions: CodecCondition[] = [
      { codec: 'h264', maxLevel: 41, profiles: ['baseline', 'constrained baseline', 'main', 'high'], maxBitDepth: 8 },
    ];
    if (caps.videoCodecs.includes('hevc')) {
      videoCodecs.push('hevc', 'h265', 'hvc1', 'hev1');
      codecConditions.push({
        codec: 'hevc', maxLevel: 150,
        profiles: caps.hevcMain10 ? ['main', 'main 10'] : ['main'],
        maxBitDepth: caps.hevcMain10 ? 10 : 8,
      });
    }
    if (caps.videoCodecs.includes('av1')) {
      videoCodecs.push('av1');
      codecConditions.push({
        codec: 'av1',
        profiles: caps.av1Main10 ? ['main', 'high'] : ['main'],
        maxBitDepth: caps.av1Main10 ? 10 : 8,
      });
    }
    const hdrCapable = caps.hdr === true && !!(caps.hevcMain10 || caps.av1Main10);
    return { videoCodecs, codecConditions, hdrCapable };
  }

  /** Cache key for receiver-probed capabilities. */
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

  /** Asks the receiver for its MSE-supported codecs on `urn:x-cast:app.fliks.caps`; cached per device. */
  private async probeReceiverCapabilities(): Promise<void> {
    const session = (window as any).cast?.framework?.CastContext
      ?.getInstance?.()
      ?.getCurrentSession?.();
    if (!session) {
      return;
    }
    const deviceName = session.getCastDevice?.()?.friendlyName;
    if (!deviceName) {
      return;
    }
    // Skip if we already have caps for this device — the probe is idempotent
    // but each round-trip is ~150–300 ms and slows the first loadMedia.
    const cached = this.castSettings.getDeviceCapabilities(deviceName);
    if (cached && (cached.v ?? 1) >= RECEIVER_CAPS_VERSION) {
      return;
    }

    const namespace = 'urn:x-cast:app.fliks.caps';
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (reason: string) => {
        if (settled) return;
        settled = true;
        try { session.removeMessageListener?.(namespace, listener); } catch { /* noop */ }
        resolve();
      };
      const listener = (_ns: string, raw: string) => {
        try {
          const data = JSON.parse(raw);
          if (data?.type !== 'caps') return;
          this.castSettings.setDeviceCapabilities(deviceName, {
            audioCodecs: Array.isArray(data.audioCodecs) ? data.audioCodecs : [],
            videoCodecs: Array.isArray(data.videoCodecs) ? data.videoCodecs : [],
            v: typeof data.v === 'number' ? data.v : undefined,
            hevcMain10: data.hevcMain10 === true,
            av1Main10: data.av1Main10 === true,
            hdr: data.hdr === true,
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
      // Older receivers don't implement the namespace and never answer.
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
  readonly playbackMode = signal<PlaybackMode>('transcode');

  // Options
  readonly availableSubtitles = signal<CastSubtitleOption[]>([]);
  readonly availableQualities = signal<CastQualityOption[]>([]);
  readonly availableAudioTracks = signal<CastAudioOption[]>([]);

  // Active selections
  readonly activeQualityId = signal('auto');
  readonly activeSubtitleId = signal<string | null>(null);
  readonly activeAudioTrackId = signal<string | null>(null);
  /** The active audio as an index into the file's `streamInfo.audio`: the number in its id. */
  readonly activeAudioStreamIndex = computed(() => {
    const id = this.activeAudioTrackId();
    const idx = id ? parseAudioIndex(id) : NaN;
    return Number.isNaN(idx) ? undefined : idx;
  });

  // Internal state
  private activeBurnInId: number | null = null;
  /** File the active picks were made on; survives {@link clear} so a player that
   *  outlives the session can adopt them. */
  private selectionFileId = 0;
  private saveInterval: ReturnType<typeof setInterval> | null = null;

  /** Whether a Cast session is actively playing media (not just connected). */
  readonly hasMedia = signal(false);
  /** Whether the Cast overlay card is expanded. */
  readonly expanded = signal(false);
  /** Server-side session id of the Cast stream, heartbeated instead of the sender's local sid while casting. */
  readonly liveSessionId = signal<string | null>(null);
  /** The viewing being cast; kept from the local player that handed it over. */
  private playbackId: string | null = null;

  startCast(opts: {
    playbackId?: string;
    mediaFileId: number;
    mediaId: number;
    episodeId?: number;
    mediaTitle: string;
    episodeTitle: string;
    fanartUrl: string | null;
    playbackMode: PlaybackMode;
    subtitles: SubtitleOption[];
    qualities: CastQualityOption[];
    audioTracks: CastAudioOption[];
    activeQualityId: string;
    activeSubtitleId: string | null;
    activeAudioStreamIndex: number | undefined;
  }) {
    this.playbackId = opts.playbackId ?? newPlaybackId();
    this.mediaFileId.set(opts.mediaFileId);
    this.mediaId.set(opts.mediaId);
    this.episodeId.set(opts.episodeId);
    this.mediaTitle.set(opts.mediaTitle);
    this.episodeTitle.set(opts.episodeTitle);
    this.fanartUrl.set(opts.fanartUrl ?? null);
    this.playbackMode.set(opts.playbackMode);
    this.selectionFileId = opts.mediaFileId;
    this.activeQualityId.set(opts.activeQualityId);
    this.activeSubtitleId.set(opts.activeSubtitleId);
    this.activeAudioTrackId.set(
      opts.activeAudioStreamIndex != null ? `audio-${opts.activeAudioStreamIndex}` : null,
    );
    this.activeBurnInId = castBurnInId(opts.subtitles, opts.activeSubtitleId);

    // The track ids are the positions dispatchLoad gives the tracks it sends, i.e. every
    // non-burn-in one in list order.
    let trackId = 1;
    this.availableSubtitles.set(opts.subtitles.map(s => {
      const burnIn = !!s.isImage;
      return {
        id: s.id,
        label: s.label,
        head: s.menuHead,
        sub: s.menuSub,
        language: s.language,
        languageTag: s.languageTag,
        burnIn,
        isImage: s.isImage,
        forced: s.forced,
        hearingImpaired: s.hearingImpaired,
        subtitleDbId: s.subtitleDbId,
        castTrackId: burnIn ? s.subtitleDbId : trackId++,
      };
    }));
    this.availableQualities.set(opts.qualities);
    this.availableAudioTracks.set(opts.audioTracks);
    this.hasMedia.set(true);
    this.startPositionSaving();
    this.loadSpriteMetadata(opts.mediaFileId);
  }

  private resumeState(): CastResumeState {
    return {
      mediaFileId: this.mediaFileId(),
      mediaId: this.mediaId(),
      episodeId: this.episodeId(),
      mediaTitle: this.mediaTitle(),
      episodeTitle: this.episodeTitle(),
      fanartUrl: this.fanartUrl(),
      playbackMode: this.playbackMode(),
      liveSessionId: this.liveSessionId(),
      playbackId: this.playbackId,
      availableSubtitles: this.availableSubtitles(),
      availableQualities: this.availableQualities(),
      availableAudioTracks: this.availableAudioTracks(),
      activeQualityId: this.activeQualityId(),
      activeSubtitleId: this.activeSubtitleId(),
      activeAudioTrackId: this.activeAudioTrackId(),
      activeBurnInId: this.activeBurnInId,
    };
  }

  /** What a LOAD's customData carries; the track and quality lists are rebuilt by the next reload. */
  private stateFromReceiver(d: Record<string, unknown>): CastResumeState {
    return {
      mediaFileId: d['mediaFileId'] as number,
      mediaId: d['mediaId'] as number,
      episodeId: typeof d['episodeId'] === 'number' ? d['episodeId'] : undefined,
      mediaTitle: typeof d['title'] === 'string' ? d['title'] : '',
      episodeTitle: typeof d['subtitle'] === 'string' ? d['subtitle'] : '',
      fanartUrl: typeof d['posterUrl'] === 'string' ? d['posterUrl'] : null,
      playbackMode: 'transcode',
      liveSessionId: typeof d['sid'] === 'string' ? d['sid'] : null,
      playbackId: typeof d['playbackId'] === 'string' ? d['playbackId'] : null,
      availableSubtitles: [],
      availableQualities: [],
      availableAudioTracks: [],
      activeQualityId: 'auto',
      activeSubtitleId: null,
      activeAudioTrackId: null,
      activeBurnInId: null,
    };
  }

  private restore(s: CastResumeState): void {
    this.mediaFileId.set(s.mediaFileId);
    this.mediaId.set(s.mediaId);
    this.episodeId.set(s.episodeId);
    this.mediaTitle.set(s.mediaTitle);
    this.episodeTitle.set(s.episodeTitle);
    this.fanartUrl.set(s.fanartUrl);
    this.playbackMode.set(s.playbackMode);
    this.setLiveSession(s.liveSessionId);
    this.playbackId = s.playbackId ?? null;
    this.selectionFileId = s.mediaFileId;
    this.availableSubtitles.set(s.availableSubtitles);
    this.availableQualities.set(s.availableQualities);
    this.availableAudioTracks.set(s.availableAudioTracks);
    this.activeQualityId.set(s.activeQualityId);
    this.activeSubtitleId.set(s.activeSubtitleId);
    this.activeAudioTrackId.set(s.activeAudioTrackId);
    this.activeBurnInId = s.activeBurnInId;
    this.hasMedia.set(true);
    this.startPositionSaving();
    this.loadSpriteMetadata(s.mediaFileId);
  }

  private disconnectGrace: ReturnType<typeof setTimeout> | null = null;
  private static readonly DISCONNECT_GRACE_MS = 45_000;
  private static readonly LOAD_RETRY_DELAY_MS = 1000;

  clear() {
    if (this.disconnectGrace) {
      clearTimeout(this.disconnectGrace);
      this.disconnectGrace = null;
    }
    const castSid = this.liveSessionId();
    this.saveCastPosition(); // Save final position before clearing
    this.stopPositionSaving();
    if (castSid) this.qoeReporter.flushKeepalive(castSid);
    // Sid-scoped kill so a sender that's still watching locally on a
    // different profile isn't torn down by the cast stop.
    if (castSid) this.streamingApi.stopSession(castSid).catch(() => {});
    this.setLiveSession(null);
    this.playbackId = null;
    this.hasMedia.set(false);
    this.expanded.set(false);
    this.mediaFileId.set(0);
    this.spriteUrl.set(null);
    this.spriteMetadata.set(null);
  }

  constructor() {
    // Debounced teardown: a sender blip (Wi-Fi roam, sleep) drops the session while the TV keeps playing; CAF auto-rejoins, so reconnect cancels it.
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
    effect(() => {
      const state = this.cast.resumedState() as CastResumeState | null;
      if (state && !untracked(this.hasMedia)) untracked(() => this.restore(state));
    });
    // Web auto-join after a tab reload: the receiver still plays, rebuild from its LOAD customData.
    effect(() => {
      const data = this.cast.rejoinedMedia();
      if (data && !untracked(this.hasMedia)) untracked(() => this.restore(this.stateFromReceiver(data)));
    });
    // The native side keeps this across a reload or process restart, so the session can be
    // taken over as it was left without reloading the receiver.
    effect(() => {
      if (!this.hasMedia()) return;
      this.cast.saveResumeState(this.resumeState());
    });
    // Probe is a no-op when the cache already covers the device.
    effect(() => {
      if (this.cast.isConnected()) {
        void this.probeReceiverCapabilities();
      }
    });
    // Recoverable receiver error (session GC'd, 410 on next segment): reload a fresh stream and resume.
    this.cast.playbackError$.subscribe(({ position }) => {
      void this.recoverFromCastError(position);
    });
    this.cast.receiverError$.subscribe((e) => {
      const sid = this.liveSessionId();
      if (sid) this.qoeReporter.record(sid, { type: 'error', at: Date.now(), position: this.cast.currentTime(), ...e }, true, this.playbackId ?? undefined);
    });
  }

  /** Throttled: three recoveries within 30 s give up with a toast, so a broken stream can't loop. */
  private recoverAttempts = 0;
  private lastRecoverAt = 0;
  /** The receiver error and the native IDLE/ERROR poll fire for one failure; the second must not restart the reload. */
  private recovering = false;
  /** Latest reload wins: an older one aborts after its playback-info; `reloading` mutes the other recoveries. */
  private reloadGen = 0;
  private reloading = false;

  private async recoverFromCastError(position?: number): Promise<void> {
    if (!this.hasMedia() || this.recovering || this.reloading) return;
    const now = Date.now();
    if (now - this.lastRecoverAt > 30_000) this.recoverAttempts = 0;
    if (this.recoverAttempts >= 3) {
      this.toast.error(this.translate.instant('cast.error.recovery_failed'));
      return;
    }
    this.recoverAttempts++;
    this.lastRecoverAt = now;
    const pos = position && position > 0 ? position : this.cast.currentTime();
    this.recovering = true;
    try {
      await this.reloadCastStream(pos);
      this.recordRecovery(pos);
    } catch {
      /* a still-broken stream re-fires the error, subject to the throttle */
    } finally {
      this.recovering = false;
    }
  }

  /** Stops the old ffmpeg session once the new LOAD resolves; transcoding.service only auto-replaces on quality change. */
  async reloadCastStream(positionOverride?: number, autoplay = true, snapQualityId?: string) {
    const gen = ++this.reloadGen;
    this.reloading = true;
    try {
      await this.reload(gen, positionOverride, autoplay, snapQualityId);
    } finally {
      if (gen === this.reloadGen) this.reloading = false;
    }
  }

  private async reload(gen: number, positionOverride: number | undefined, autoplay: boolean, snapQualityId?: string) {
    const mfId = this.mediaFileId();
    if (!mfId) return;

    // Scope the stop to the Cast session's own sid so a concurrent local
    // session on the same file (another profile/device) is not torn down too.
    const oldSid = this.liveSessionId();

    const currentPos = positionOverride ?? this.cast.currentTime();
    const audioIdx = this.activeAudioStreamIndex();
    // The cast dropdown only contains concrete transcode rungs, so the
    // active id is the rung name to send to the backend.
    let transcodeQuality = this.activeQualityId();
    // First load of a cast started from the player: no ladder yet, built from this response.
    if (snapQualityId) {
      const cap = this.castSettings.get().maxQuality;
      transcodeQuality = snapQualityId === 'auto' || snapQualityId === 'original'
        ? (cap === 'original' ? '1080p' : cap)
        : snapQualityId;
    }

    // Parallel: playback-info (triggers backend prewarm) + cast token fetch.
    const [pi, castInfo] = await Promise.all([
      this.getCastPlaybackInfo(
        mfId, this.activeBurnInId ?? undefined, audioIdx,
        transcodeQuality, Math.floor(currentPos),
      ),
      this.authService.getCastInfo(),
    ]);

    if (gen !== this.reloadGen) {
      if (pi.sessionId && pi.sessionId !== this.liveSessionId()) this.streamingApi.stopSession(pi.sessionId).catch(() => {});
      return;
    }

    if (snapQualityId) {
      const qualities = buildCastQualityOptions(pi.qualities, this.castSettings.get().maxQuality);
      transcodeQuality = qualities.find(q => q.id === snapQualityId)?.id ?? qualities[0]?.id ?? '1080p';
      this.availableQualities.set(qualities);
      this.activeQualityId.set(transcodeQuality);
    }

    const loaded = await this.dispatchLoad(mfId, pi, currentPos, transcodeQuality, castInfo, autoplay);
    if (loaded && oldSid && oldSid !== pi.sessionId) this.streamingApi.stopSession(oldSid).catch(() => {});
  }

  /** Shared by quickStart and reloadCastStream; a refused LOAD is reported here and returns false. */
  private async dispatchLoad(
    mfId: number,
    pi: { playMethod: PlayMethod; playUrl: string; sessionId?: string; edl?: EdlRange[] },
    currentPos: number,
    transcodeQuality: string | undefined,
    castInfo: { token: string; streamBaseUrl: string },
    autoplay: boolean,
  ): Promise<boolean> {
    // The profile lists only the hls container: DirectPlay is unexpected here.
    if (pi.playMethod === 'DirectPlay') {
      console.warn('[cast] unexpected DirectPlay decision for a Cast session', pi);
    }
    this.playbackMode.set(playbackModeOf(pi));

    const { token: castToken, streamBaseUrl } = castInfo;
    this.cast.setCastStreamBase(streamBaseUrl);

    // Route Cast through master.m3u8 (same as desktop/Android): bypassing it
    // breaks `init_N.mp4` resolution and drops audio under var_stream_map.
    const built = this.streamingApi.buildAbsolutePlayUrl(
      pi,
      castToken,
      {
        sid: pi.sessionId,
        startAt: Math.floor(currentPos),
        startQuality: transcodeQuality ?? '1080p',
      },
    );
    const castUrl = built.url;
    const contentType = built.contentType;

    // The sender heartbeat (`savePosition`) must beat the Cast session, not the paused browser one.
    this.setLiveSession(pi.sessionId ?? null);

    const loaded = this.availableSubtitles().filter(s => !s.burnIn);
    const subtitles = loaded.map(s => ({
      url: s.id.startsWith('ext-')
        ? this.streamingApi.getAbsoluteSubtitleUrl(mfId, s.subtitleDbId!, castToken)
        : this.streamingApi.getAbsoluteEmbeddedSubtitleUrl(mfId, parseInt(s.id.replace('emb-', ''), 10), castToken),
      language: s.language,
      label: s.label,
    }));
    const activeSubtitleTrackId = loaded.find(s => s.id === this.activeSubtitleId())?.castTrackId;

    this.cast.buffering.set(true);

    const load = () => this.cast.loadMedia({
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
      mediaFileId: mfId,
      playbackId: this.playbackId ?? undefined,
      sid: pi.sessionId,
      autoSkipCommercials: this.authService.user()?.edlAutoSkipCommercials !== false,
      ...this.edlPayload(pi.edl, {
        title: this.mediaTitle(),
        subtitle: this.episodeTitle(),
        posterUrl: this.fanartUrl(),
        mediaId: this.mediaId(),
        episodeId: this.episodeId(),
        mediaFileId: mfId,
      }),
    });

    // One retry: a rejoined receiver may still hold a dead sender's media session and refuse
    // the first LOAD. Skipped when disconnected.
    try {
      try {
        await load();
      } catch (err) {
        if (!this.cast.isConnected()) throw err;
        console.warn('[cast] LOAD rejected, retrying once', err);
        await new Promise((r) => setTimeout(r, CastPlayerService.LOAD_RETRY_DELAY_MS));
        await load();
      }
      return true;
    } catch (err) {
      console.error('[cast] LOAD failed', err);
      this.cast.buffering.set(false);
      this.toast.error(this.translate.instant('cast.error.load_failed'));
      return false;
    }
  }

  /** The receiver's EDL input in compact wire form, with the notice texts in the sender's
   *  language. Dropped (cast plays without EDL) when the LOAD customData would near the 64 KB limit. */
  private edlPayload(edl: EdlRange[] | undefined, base: Record<string, unknown>) {
    if (!edl?.length) return {};
    const payload = {
      edl: encodeEdlWire(edl),
      edlLabels: {
        cut: this.translate.instant('player.edl.skipped_cut'),
        commercial: this.translate.instant('player.edl.skipped_commercial'),
      },
    };
    if (jsonBytes({ ...base, ...payload }) > CAST_CUSTOM_DATA_BUDGET) {
      console.warn('[cast] EDL too large for the LOAD message, casting without it', edl.length);
      return {};
    }
    return payload;
  }

  /** Files whose mutes ride on PCM audio: gating a Dolby passthrough stream on the receiver is
   *  unverified, so these get a profile without AC-3 / E-AC-3. */
  private readonly pcmForMutes = new Set<number>();

  /** Playback-info for the cast profile. When the answer carries mute ranges and the profile
   *  would let Dolby audio through, asks once more with a profile that forces a transcode to AAC. */
  private async getCastPlaybackInfo(
    mfId: number,
    burnInId: number | undefined,
    audioIdx: number | undefined,
    quality: string | undefined,
    startAt: number | undefined,
  ) {
    const request = (profile: DeviceProfile) =>
      this.streamingApi.getPlaybackInfo(mfId, profile, burnInId, audioIdx, quality, startAt);
    const profile = this.getCastDeviceProfile();
    const withoutDolby = (): DeviceProfile => ({
      ...profile,
      directPlayProfiles: profile.directPlayProfiles.map((p) => ({
        ...p,
        audioCodecs: p.audioCodecs.filter((c) => c !== 'ac3' && c !== 'eac3'),
      })),
    });
    const dolby = profile.directPlayProfiles.some((p) =>
      p.audioCodecs.some((c) => c === 'ac3' || c === 'eac3'),
    );
    if (this.pcmForMutes.has(mfId) && dolby) return request(withoutDolby());
    const pi = await request(profile);
    const dolbyOut = pi.outputAudioCodec === 'ac3' || pi.outputAudioCodec === 'eac3';
    if (!dolby || !dolbyOut || !pi.edl || !muteRangesOf(pi.edl).length) return pi;
    this.pcmForMutes.add(mfId);
    if (pi.sessionId) await this.streamingApi.stopSession(pi.sessionId).catch(() => {});
    return request(withoutDolby());
  }

  async changeQuality(qualityId: string) {
    this.activeQualityId.set(qualityId);
    await this.reloadCastStream();
  }

  async changeAudio(audioIndex: number) {
    const trackId = `audio-${audioIndex}`;
    this.trackManager.saveAudioSelection(
      trackId, this.availableAudioTracks(), this.mediaId(),
    );
    this.activeAudioTrackId.set(trackId);

    // Fast path: swap the audio rendition on the media bus with no ffmpeg restart; full reload if the receiver hasn't published it.
    const audio = this.availableAudioTracks()[audioIndex];
    if (audio && (await this.cast.setActiveAudioLanguage(audio.language, audio.name))) {
      return;
    }

    await this.reloadCastStream();
  }

  /** A new session id means new media: the receiver's previous sample no longer applies. */
  private setLiveSession(id: string | null) {
    this.liveSessionId.set(id);
    this.cast.receiverQoe?.set(null);
    this.recoveries = 0;
    this.seenStalls = new Set();
  }

  /** The reload that just minted the current sid was a recovery. */
  private recordRecovery(position: number, reason?: QoeRecoveryReason): void {
    this.recoveries = 1;
    const sid = this.liveSessionId();
    if (sid) this.qoeReporter.record(sid, { type: 'recovery', at: Date.now(), position, reason }, false, this.playbackId ?? undefined);
  }

  /** Recovery reloads of the current sid: the receiver never reloads on its own. */
  private recoveries = 0;
  private seenStalls = new Set<number>();

  private readonly receiverStallEffect = effect(() => {
    const q = this.cast.receiverQoe();
    untracked(() => this.recordReceiverStalls(q));
  });

  /** Receiver stall episodes become `stall` events once each, deduped by start time. */
  private recordReceiverStalls(q: ReceiverSample | null): void {
    const sid = this.liveSessionId();
    if (!q || !sid || fromOtherLoad(q, sid)) return;
    const sample = q.sample;
    for (const s of sample.stalls ?? []) {
      if (this.seenStalls.has(s.at)) continue;
      this.seenStalls.add(s.at);
      const { at, ...rest } = s;
      this.qoeReporter.record(sid, { type: 'stall', at: at + s.durationMs, ...rest }, false, this.playbackId ?? undefined);
    }
  }

  /** Receiver's latest QoE sample for the heartbeat; null when stale or the sender can't receive it. */
  qoeSample(): QoeSample | null {
    const q = this.cast.receiverQoe();
    if (!q || fromOtherLoad(q, this.liveSessionId()) || Date.now() - q.receivedAt >= QOE_STALE_MS || !hasQoeData(q.sample)) return null;
    const { stalls: _stalls, ...sample } = q.sample;
    return {
      ...sample,
      recoveryReloads: sample.recoveryReloads + this.recoveries,
      playbackId: sample.playbackId || this.playbackId || undefined,
    };
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
      // Once the player page is gone this loop is the only keep-alive; without the sid the backend GCs the session and the receiver 410s.
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
        ...(sid ? { qoe: this.qoeSample() ?? undefined } : {}),
      });
      // Backend lost the session: reload with a fresh sid, preserving the receiver's pause state.
      if (sid) void this.qoeReporter.flush(sid);
      if (response?.sessionLost && !this.reloading) {
        await this.reloadCastStream(pos, !this.cast.isPaused());
        this.recordRecovery(pos, 'session_lost');
      }
    } catch { /* ignore */ }
  }

  /** A viewer's subtitle pick (null: Off), applied and remembered for the title. Burn-in is
   *  part of the pick: a text track clears it, as the local player does. False for an unknown id. */
  async selectSubtitle(id: string | null): Promise<boolean> {
    const opt = id ? this.availableSubtitles().find((s) => s.id === id) : undefined;
    if (id && !opt) {
      console.warn('[cast] unknown subtitle', id);
      return false;
    }
    this.activeSubtitleId.set(id);
    this.rememberSubtitle(opt);
    const burnInId = opt?.isImage ? (opt.subtitleDbId ?? null) : null;
    // A burn-in change reloads, and the new LOAD already carries the active text track.
    if (burnInId !== this.activeBurnInId) {
      this.activeBurnInId = burnInId;
      await this.reloadCastStream();
    } else await this.cast.setActiveSubtitle(opt && !opt.burnIn ? (opt.castTrackId ?? 0) : 0);
    return true;
  }

  private rememberSubtitle(opt: CastSubtitleOption | undefined): void {
    const mediaId = this.mediaId();
    if (!mediaId) return;
    this.trackManager.saveSubtitleSelection(
      mediaId,
      opt?.language ?? null,
      opt?.forced,
      !!opt?.id.startsWith('emb-'),
      !!opt?.isImage,
      opt?.hearingImpaired,
      opt?.languageTag,
    );
  }

  /** What was picked on the receiver for `mediaFileId`, for a player that outlives the
   *  session; null when the picks belong to another file. */
  selectionFor(mediaFileId: number): { subtitleId: string | null; audioStreamIndex: number | undefined } | null {
    if (!mediaFileId || mediaFileId !== this.selectionFileId) return null;
    return { subtitleId: this.activeSubtitleId(), audioStreamIndex: this.activeAudioStreamIndex() };
  }

  /** The subtitle the player's own rules start `subtitles` on, automatic like its
   *  first pick: never remembered as the viewer's choice. */
  async resolveStartSubtitle(
    subtitles: SubtitleOption[],
    mediaFileId: number,
    mediaId: number,
    audioLanguage?: string,
    launchPick?: string | null,
  ): Promise<SubtitleOption | null> {
    let picked: SubtitleOption | null = null;
    await this.trackManager.autoSelectSubtitle(
      subtitles, [], null, mediaFileId, async (sub) => { picked = sub; }, mediaId, audioLanguage, launchPick,
    );
    return picked;
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

  /** `tracks` are the viewer's picks for this start, honoured over the rules and never remembered. */
  async quickStart(opts: {
    mediaFileId: number;
    mediaId: number;
    episodeId?: number;
    title: string;
    episodeTitle?: string;
    fanartUrl?: string | null;
    streamInfo?: any;
    startTime?: number;
    tracks?: LaunchTracks;
    /** Open the overlay once the cast state is set, without waiting for the receiver's LOAD. */
    expand?: boolean;
  }) {
    // Phase 1: fetches independent of streamInfo run in parallel; `original` audio needs the media payload's language.
    const needsMediaFetch =
      !opts.streamInfo ||
      this.playerSettings.get().audioSelectionMode === 'original';
    const [mediaResult, subsResult, castInfo] = await Promise.all([
      needsMediaFetch
        ? this.mediaService.getOne(opts.mediaId).catch(() => null)
        : Promise.resolve(null),
      this.subtitlesApi.getForMedia(opts.mediaId).catch(() => [] as SubtitleFileRow[]),
      this.authService.getCastInfo(),
    ]);

    let streamInfo = opts.streamInfo;
    let fanartUrl = opts.fanartUrl ?? null;
    if (mediaResult) {
      const file = mediaResult.files?.find((f) => f.id === opts.mediaFileId);
      streamInfo = file?.streamInfo ?? opts.streamInfo;
      if (!fanartUrl && mediaResult.fanartUrl) fanartUrl = mediaResult.fanartUrl;
    }
    if (fanartUrl) fanartUrl = this.serverConfig.resolveUrl(fanartUrl);

    const launchPick = launchPickFor(opts.tracks, opts.mediaFileId);
    const audioStreams: AudioStreamChoice[] = streamInfo?.audio ?? [];
    const audioIndex = this.playerSettings.resolveAudioStreamIndex(
      opts.mediaFileId, audioStreams, opts.mediaId,
      mediaResult?.metadata?.originalLanguage ?? null,
      launchPick?.audioStreamIndex,
    );

    // Build subtitle list from the parallel fetch (shared with the player).
    const subtitleInfos: SubtitleOption[] = buildSubtitleTracks(
      subsResult,
      opts.mediaFileId,
      { hideBurnIn: this.appSettings.hideBurnInSubtitles(), streams: streamInfo?.subtitles },
    ).map((t, i) => ({
      id: t.key,
      ...this.trackManager.describeSubtitle(t, i + 1),
      language: t.language,
      languageTag: t.languageTag,
      isImage: t.isImage,
      burnIn: t.isImage,
      providerType: t.providerType,
      subtitleDbId: t.subtitleId,
      url:
        t.kind === 'external'
          ? this.streamingApi.getSubtitleUrl(opts.mediaFileId, t.subtitleId)
          : t.isImage
            ? ''
            : this.streamingApi.getEmbeddedSubtitleUrl(opts.mediaFileId, t.streamIndex!),
      forced: t.forced,
      hearingImpaired: t.hearingImpaired,
    }));

    const audioTracks = buildCastAudioOptions(streamInfo?.audio, this.translate);
    const startSubtitle = await this.resolveStartSubtitle(
      subtitleInfos, opts.mediaFileId, opts.mediaId,
      audioIndex != null ? audioStreams[audioIndex]?.language : undefined,
      launchPick?.subtitleId,
    );

    // Phase 2: the user's cast cap goes as startQuality; the backend snaps it to what the source can serve.
    const cs = this.castSettings.get();
    const startQuality = cs.maxQuality === 'original' ? '1080p' : cs.maxQuality;
    const pi = await this.getCastPlaybackInfo(
      opts.mediaFileId, castBurnInId(subtitleInfos, startSubtitle?.id ?? null) ?? undefined,
      audioIndex, startQuality, opts.startTime == null ? undefined : Math.floor(opts.startTime),
    );
    // Explicit start, else the server's resume point.
    const startTime = opts.startTime ?? pi.startAtSeconds;

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
      activeSubtitleId: startSubtitle?.id ?? null,
      activeAudioStreamIndex: audioIndex,
    });
    if (opts.expand) this.expanded.set(true);

    if (!(await this.dispatchLoad(opts.mediaFileId, pi, startTime, activeQualityId, castInfo, true))) {
      // Nothing is playing: drop the dead overlay (and its transcode) so a new cast starts clean.
      this.clear();
    }
  }
}
