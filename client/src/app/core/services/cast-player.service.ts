import { DestroyRef, Injectable, Injector, computed, effect, inject, signal, untracked } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { CastService, type CastResumeState } from './cast.service';
import { SessionSyncService } from './session-sync.service';
import type { QoeSample } from './playback-engine';
import { hasQoeData } from './playback-engine/playback-engine';
import { QoeReporter, newPlaybackId } from './qoe-reporter.service';
import type { QoeRecoveryReason } from './api/qoe-api.service';
import { CastDeviceCapabilities, CastSettingsService } from './cast-settings.service';
import { StreamingApiService, type PlayMethod } from './api/streaming-api.service';
import { SubtitlesApiService, type SubtitleFileRow } from './api/subtitles-api.service';
import { AppSettingsService } from './app-settings.service';
import { buildSubtitleTracks, burnsIn } from '../utils/subtitle-tracks';
import { normalizeLangCode } from '../utils/language.utils';
import { LatestWins } from '../utils/latest-wins';
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
import { NetworkService } from './network.service';
import type { RecoveryController } from '../../features/player/recovery-controller';
import { ServerConfigService } from './server-config.service';
import { SseService } from './sse.service';
import { formatAudioParts, formatAudioLabel, parseAudioIndex, playbackModeOf, SpriteMetadata, type PlaybackMode, type TimeMarker } from '../utils/player.utils';
import {
  PlayerSettingsService,
  type AudioStreamChoice,
} from './player-settings.service';
import { TrackManagerService, launchPickFor, type LaunchTracks, type SubtitleOption } from './track-manager.service';
import type { Media } from './api/media.service';
import { NO_NOW_PLAYING, NowPlayingMetadataService } from './playback/now-playing-metadata.service';
import type { HeartbeatSource, PlaybackHeartbeat } from './playback/playback-heartbeat';
import { CastPlaybackTarget } from './cast-playback-target';
import { NO_TIMELINE, type PlaybackTimeline } from './playback/playback-output';
import { PlaybackSession } from './playback/playback-session';
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
 *  subtitles, so every image and styled track is burned in, whatever the local device renders itself. */
export function castBurnInId(subtitles: SubtitleOption[], activeId: string | null): number | null {
  const active = subtitles.find((s) => s.id === activeId);
  return active && burnsIn(active, false) ? (active.subtitleDbId ?? null) : null;
}

/** Everything {@link CastPlayerService} needs to take a session over again. */
interface VideoCastState {
  mediaFileId: number;
  mediaId: number;
  episodeId: number | undefined;
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
  timeline?: PlaybackTimeline;
}

/** A marker from untyped receiver `customData`, or null. */
function markerOf(v: unknown): TimeMarker | null {
  const m = v as Partial<TimeMarker> | null | undefined;
  return typeof m?.startSeconds === 'number' && typeof m.endSeconds === 'number' ? { startSeconds: m.startSeconds, endSeconds: m.endSeconds } : null;
}

/** Receiver probe version that reports the 10-bit and HDR fields; an older cached answer is re-probed. */
const RECEIVER_CAPS_VERSION = 2;
/** The probe version that also reports the audio files; an older answer is asked again. */
const RECEIVER_CAPS_LATEST = 3;

/** A receiver sample older than this is dropped (receiver gone or not pushing). */
const QOE_STALE_MS = 30_000;

type ReceiverSample = NonNullable<ReturnType<CastService['receiverQoe']>>;

/** A sample of the previous load, still in flight when a reload minted a new sid. */
const fromOtherLoad = (q: ReceiverSample, sid: string | null) => !!q.sid && q.sid !== sid;

/** Global Cast stream state, so the Cast overlay works independently of PlayerComponent. */
@Injectable({ providedIn: 'root' })
export class CastPlayerService {
  readonly cast = inject(CastService);
  private readonly injector = inject(Injector);
  private readonly _destroyed = inject(DestroyRef).onDestroy(() => {
    this.destroyed = true;
    this.unregisterHeartbeat?.();
  });
  private readonly sessionSync = inject(SessionSyncService);
  /** Loaded on the first Cast session: the beater and its offline stack stay off the initial bundle. */
  private heartbeat: PlaybackHeartbeat | null = null;
  private heartbeatWanted = false;
  private readonly castSettings = inject(CastSettingsService);
  private readonly streamingApi = inject(StreamingApiService);
  private readonly qoeReporter = inject(QoeReporter);
  private readonly subtitlesApi = inject(SubtitlesApiService);
  private readonly appSettings = inject(AppSettingsService);
  private readonly authService = inject(AuthService);
  private readonly sse = inject(SseService);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly nowPlaying = inject(NowPlayingMetadataService);
  private readonly playerSettings = inject(PlayerSettingsService);
  private readonly trackManager = inject(TrackManagerService);
  readonly translate = inject(TranslateService);
  readonly toast = inject(ToastService);
  readonly network = inject(NetworkService);

  /** One profile for every kind, from the receiver's probe: its MSE codecs and the audio files it opens.
   * Without a v2 probe `videoCodecs` stays empty (H.264 SDR transcode) and audio is AAC stereo. */
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
        ...(caps?.audioFiles?.containers.length ? [caps.audioFiles] : []),
      ],
      codecConditions: caps?.audioFiles?.audioCodecs.includes('flac')
        ? [...codecConditions, { codec: 'flac', maxBitDepth: 24 }]
        : codecConditions,
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
    // The receiver's Chromium demuxer takes in-band entries (`avc3`, `hev1`), not Dolby Vision
    // ones without a DV decoder.
    const videoCodecs = ['h264', 'avc1', 'avc3'];
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
    if (cached && (cached.v ?? 1) >= RECEIVER_CAPS_LATEST) {
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
            audioFiles: data.audioFiles?.containers ? data.audioFiles : undefined,
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
  readonly playbackMode = signal<PlaybackMode>('transcode');
  /** Markers, chapters and EDL of the file on the receiver, from its playback-info. */
  readonly timeline = signal<PlaybackTimeline>(NO_TIMELINE);

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
  private unregisterHeartbeat: (() => void) | null = null;

  /** Whether a Cast session is actively playing media (not just connected). */
  readonly hasMedia = signal(false);
  /** Server-side session id of the Cast stream, heartbeated instead of the sender's local sid while casting. */
  readonly liveSessionId = signal<string | null>(null);
  /** The viewing being cast; kept from the local player that handed it over. */
  private playbackId: string | null = null;

  startCast(opts: {
    playbackId?: string;
    mediaFileId: number;
    mediaId: number;
    episodeId?: number;
    playbackMode: PlaybackMode;
    subtitles: SubtitleOption[];
    qualities: CastQualityOption[];
    audioTracks: CastAudioOption[];
    activeQualityId: string;
    activeSubtitleId: string | null;
    activeAudioStreamIndex: number | undefined;
  }) {
    this.failed.set(false);
    this.recovery?.clearEpisode();
    this.playbackId = opts.playbackId ?? newPlaybackId();
    this.mediaFileId.set(opts.mediaFileId);
    this.mediaId.set(opts.mediaId);
    this.episodeId.set(opts.episodeId);
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
      const burnIn = burnsIn(s, false);
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
    this.registerHeartbeat();
    this.loadSpriteMetadata(opts.mediaFileId);
  }

  private resumeState(): VideoCastState {
    return {
      mediaFileId: this.mediaFileId(),
      mediaId: this.mediaId(),
      episodeId: this.episodeId(),
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
      timeline: this.timeline(),
    };
  }

  /** What a LOAD's customData carries; the track and quality lists are rebuilt by the next reload. */
  private stateFromReceiver(d: Record<string, unknown>): VideoCastState {
    return {
      mediaFileId: d['mediaFileId'] as number,
      mediaId: d['mediaId'] as number,
      episodeId: typeof d['episodeId'] === 'number' ? d['episodeId'] : undefined,
      playbackMode: 'transcode',
      liveSessionId: typeof d['sid'] === 'string' && !this.controlOnly() ? d['sid'] : null,
      playbackId: typeof d['playbackId'] === 'string' ? d['playbackId'] : null,
      availableSubtitles: [],
      availableQualities: [],
      availableAudioTracks: [],
      activeQualityId: 'auto',
      activeSubtitleId: null,
      activeAudioTrackId: null,
      activeBurnInId: null,
      timeline: { ...NO_TIMELINE, intro: markerOf(d['intro']), outro: markerOf(d['outro']) },
    };
  }

  /** Takes over the video session a native or desktop sender kept alive. */
  adopt(state: CastResumeState): void {
    if (!this.hasMedia()) this.restore(state as unknown as VideoCastState);
  }

  /** The receiver plays a session another user's sender loaded: this sender is a remote control and makes no
   *  server-side session call for it. */
  readonly controlOnly = computed(() => {
    const owner = this.cast.receiverMedia()?.['userId'];
    return typeof owner === 'number' && owner !== this.authService.user()?.id;
  });

  private followReceiver(data: Record<string, unknown> | null): void {
    if (!data || !this.cast.isConnected() || this.reloading()) return;
    // A music track (its LOAD carries an `itemId`) belongs to the audio player.
    if (typeof data['mediaFileId'] !== 'number' || typeof data['mediaId'] !== 'number' || typeof data['itemId'] === 'number') {
      if (this.hasMedia()) this.clear();
    } else if (!this.hasMedia() || data['mediaFileId'] !== this.mediaFileId()) {
      this.restore(this.stateFromReceiver(data));
    }
  }

  private restore(s: VideoCastState): void {
    this.failed.set(false);
    this.recovery?.clearEpisode();
    this.mediaFileId.set(s.mediaFileId);
    this.mediaId.set(s.mediaId);
    this.episodeId.set(s.episodeId);
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
    this.timeline.set(s.timeline ?? NO_TIMELINE);
    this.hasMedia.set(true);
    if (!this.controlOnly()) this.registerHeartbeat();
    this.loadSpriteMetadata(s.mediaFileId);
  }

  private disconnectGrace: ReturnType<typeof setTimeout> | null = null;
  private static readonly DISCONNECT_GRACE_MS = 45_000;
  private static readonly LOAD_RETRY_DELAY_MS = 1000;

  /** Stops the receiver's media and forgets it; the device stays connected. */
  stop(): void {
    this.cast.stop();
    this.clear();
  }

  /** Ends the Cast session, which stops the receiver with it, and forgets its media. */
  leave(): void {
    this.cast.disconnect();
    this.clear();
  }

  clear() {
    if (this.disconnectGrace) {
      clearTimeout(this.disconnectGrace);
      this.disconnectGrace = null;
    }
    const castSid = this.liveSessionId();
    void this.heartbeat?.bank();
    this.heartbeatWanted = false;
    this.unregisterHeartbeat?.();
    this.unregisterHeartbeat = null;
    if (castSid) this.qoeReporter.flushKeepalive(castSid);
    // Sid-scoped kill so a sender that's still watching locally on a
    // different profile isn't torn down by the cast stop.
    if (castSid) this.streamingApi.stopSession(castSid).catch(() => {});
    this.setLiveSession(null);
    this.playbackId = null;
    this.hasMedia.set(false);
    this.cast.clearResumeState('video');
    this.mediaFileId.set(0);
    this.mediaId.set(0);
    this.episodeId.set(undefined);
    this.timeline.set(NO_TIMELINE);
    this.spriteUrl.set(null);
    this.spriteMetadata.set(null);
  }

  constructor() {
    // The receiver plays this device's session: a takeover leaves it, as this device then plays nothing there.
    this.sessionSync.registerPlayer({
      sessionId: () => this.liveSessionId() ?? undefined,
      active: () => this.hasMedia() && !this.controlOnly(),
      // A takeover by another sender of the receiver leaves its playback alone.
      yield: async () => (this.cast.receiverPlaysSession(this.liveSessionId()) ? this.leave() : this.clear()),
    });
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
    // The receiver is the source of truth: a tab reload rejoins its media, another sender's LOAD replaces ours.
    effect(() => {
      const data = this.cast.receiverMedia();
      untracked(() => this.followReceiver(data));
    });
    // The native side keeps this across a reload or process restart, so the session can be
    // taken over as it was left without reloading the receiver.
    effect(() => {
      if (!this.hasMedia()) return;
      this.cast.saveResumeState('video', this.resumeState());
    });
    // Probe is a no-op when the cache already covers the device.
    effect(() => {
      if (this.cast.isConnected()) {
        void this.probeReceiverCapabilities();
      }
    });
    // The controller (receiver errors, stall watchdog) loads once there is media to recover.
    effect(() => {
      if (this.hasMedia() && this.cast.isConnected()) void this.controller();
    });
    // A hardware fallback moved the session's init: the receiver fetched the old one once, so it reloads.
    this.sse.on('stream.reload').subscribe((e) => this.onStreamReload(e['sessionId']));
    this.cast.receiverError$.subscribe((e) => {
      const sid = this.liveSessionId();
      if (sid) this.qoeReporter.record(sid, { type: 'error', at: Date.now(), position: this.cast.currentTime(), ...e }, true, this.playbackId ?? undefined);
    });
  }

  private onStreamReload(sessionId: unknown): void {
    if (sessionId === this.liveSessionId() && this.cast.isConnected()) void this.reloadCastStream();
  }

  /** Latest reload wins: an older one aborts after its playback-info; `reloading` mutes the other recoveries. */
  readonly reloads = new LatestWins();
  readonly reloading = signal(false);
  /** Recovery gave up: the failure toast is up and nothing retries until new media loads. */
  readonly failed = signal(false);
  destroyed = false;
  /** The position the receiver reported with its error, consumed by the recovery it triggers. */
  errorPosition = 0;

  private recovery: RecoveryController | null = null;
  private recoveryLoad: Promise<RecoveryController | null> | null = null;

  /** Loaded on first use: the controller belongs to the lazy player chunk, not the initial one. */
  private controller(): Promise<RecoveryController | null> {
    return (this.recoveryLoad ??= import('../../features/player/cast-recovery').then(
      (m) => (this.destroyed ? null : (this.recovery = m.castRecovery(this, this.injector))),
    ));
  }

  /** Opens the new session as the replacement of the old one; the receiver plays its buffered segments until the LOAD lands. */
  async reloadCastStream(positionOverride?: number, autoplay = true, snapQualityId?: string) {
    const token = this.reloads.begin();
    this.failed.set(false);
    this.reloading.set(true);
    try {
      return await this.reload(token, positionOverride, autoplay, snapQualityId);
    } finally {
      if (this.reloads.isCurrent(token)) this.reloading.set(false);
    }
  }

  private async reload(
    token: number,
    positionOverride: number | undefined,
    autoplay: boolean,
    snapQualityId?: string,
  ): Promise<'done' | 'superseded' | 'refused'> {
    const mfId = this.mediaFileId();
    if (!mfId) return 'done';

    // Scoped to the Cast session's own sid so a concurrent local session on the same file is not torn down too.
    const { replaces } = await this.streamingApi.retireSession(this.liveSessionId() ?? undefined);

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
        transcodeQuality, Math.floor(currentPos), replaces,
      ),
      this.authService.getCastInfo(mfId),
    ]);

    if (!this.reloads.isCurrent(token)) {
      if (pi.sessionId && pi.sessionId !== this.liveSessionId()) this.streamingApi.stopSession(pi.sessionId).catch(() => {});
      return 'superseded';
    }

    if (pi.burnInDropped != null && pi.burnInDropped === this.activeBurnInId) {
      this.activeBurnInId = null;
      this.activeSubtitleId.set(null);
    }

    if (snapQualityId) {
      const qualities = buildCastQualityOptions(pi.qualities, this.castSettings.get().maxQuality);
      transcodeQuality = qualities.find(q => q.id === snapQualityId)?.id ?? qualities[0]?.id ?? '1080p';
      this.availableQualities.set(qualities);
      this.activeQualityId.set(transcodeQuality);
    }

    return (await this.dispatchLoad(mfId, pi, currentPos, transcodeQuality, castInfo, autoplay)) ? 'done' : 'refused';
  }

  /** Shared by quickStart and reloadCastStream; a refused LOAD is reported here and returns false. */
  private async dispatchLoad(
    mfId: number,
    pi: {
      playMethod: PlayMethod; playUrl: string; sessionId?: string; edl?: EdlRange[];
      markers?: { intro?: TimeMarker; outro?: TimeMarker }; chapters?: PlaybackTimeline['chapters'];
    },
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
    this.timeline.set({
      intro: pi.markers?.intro ?? null,
      outro: pi.markers?.outro ?? null,
      chapters: pi.chapters ?? [],
      edl: pi.edl ?? [],
    });

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

    // The heartbeat must beat the Cast session, not the paused browser one.
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

    const meta = await this.nowPlaying.load({ mediaId: this.mediaId(), episodeId: this.episodeId() }).catch(() => NO_NOW_PLAYING);
    const art = meta.fanartUrl ?? meta.posterUrl;
    const posterUrl = art ? this.serverConfig.resolveUrl(art) : undefined;
    const load = () => this.cast.loadMedia({
      url: castUrl,
      contentType,
      title: meta.title,
      subtitle: meta.episodeLabel || undefined,
      posterUrl,
      currentTime: currentPos,
      subtitles,
      activeSubtitleTrackId,
      mediaId: this.mediaId(),
      episodeId: this.episodeId(),
      autoplay,
      mediaFileId: mfId,
      playbackId: this.playbackId ?? undefined,
      sid: pi.sessionId,
      userId: this.authService.user()?.id,
      autoSkipCommercials: this.authService.user()?.edlAutoSkipCommercials !== false,
      intro: pi.markers?.intro,
      outro: pi.markers?.outro,
      ...this.edlPayload(pi.edl, {
        title: meta.title,
        subtitle: meta.episodeLabel,
        posterUrl: posterUrl ?? null,
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
    replaces?: string,
  ) {
    const request = (profile: DeviceProfile, replacing?: string) =>
      this.streamingApi.getPlaybackInfo(mfId, profile, burnInId, audioIdx, quality, startAt, undefined, { replaces: replacing });
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
    if (this.pcmForMutes.has(mfId) && dolby) return request(withoutDolby(), replaces);
    const pi = await request(profile, replaces);
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
  recordRecovery(position: number, reason?: QoeRecoveryReason): void {
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

  private registerHeartbeat(): void {
    this.heartbeatWanted = true;
    void import('./playback/playback-heartbeat').then((m) => {
      if (this.destroyed) return;
      this.heartbeat = this.injector.get(m.PlaybackHeartbeat);
      if (this.heartbeatWanted) this.unregisterHeartbeat ??= this.heartbeat.register(this.heartbeatSource, 'receiver');
    });
  }

  /** Beats for the receiver once the player page is gone: without it the backend GCs the session and the receiver 410s. */
  readonly heartbeatSource: HeartbeatSource = {
    output: () => this.injector.get(CastPlaybackTarget),
    item: () => ({ mediaId: this.mediaId(), fileId: this.mediaFileId(), episodeId: this.episodeId() }),
    reportable: () => !!this.mediaFileId() && !!this.mediaId(),
    extras: (sid) => ({
      castDevice: this.cast.deviceName() ?? undefined,
      episodeLabel: sid ? this.injector.get(PlaybackSession).nowPlaying()?.episodeLabel || null : undefined,
      qoe: (sid && this.qoeSample()) || undefined,
    }),
    background: async ({ url, body, token }) => {
      const t = await token();
      if (t) this.cast.saveHeartbeat({ url, token: t, body });
    },
    onLostSession: (position) => this.recoverLostSession(position),
  };

  /** The backend lost the session: reload with a fresh sid, preserving the receiver's pause state. */
  async recoverLostSession(position: number): Promise<void> {
    if (this.reloading()) return;
    try {
      await this.reloadCastStream(position, !this.cast.isPaused());
      this.recordRecovery(position, 'session_lost');
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
    const burnInId = opt?.burnIn ? (opt.subtitleDbId ?? null) : null;
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
    streamInfo?: any;
    startTime?: number;
    tracks?: LaunchTracks;
    /** False loads the receiver paused. */
    autoplay?: boolean;
    /** Already loaded by the caller: skips the fetch. */
    media?: Media;
  }) {
    // Phase 1: fetches independent of streamInfo run in parallel; `original` audio needs the media payload's language.
    const [mediaResult, subsResult, castInfo] = await Promise.all([
      this.nowPlaying.media(opts.mediaId, opts.media).catch(() => null),
      this.subtitlesApi.getForMedia(opts.mediaId).catch(() => [] as SubtitleFileRow[]),
      this.authService.getCastInfo(opts.mediaFileId),
    ]);

    let streamInfo = opts.streamInfo;
    if (mediaResult) {
      const file = mediaResult.files?.find((f) => f.id === opts.mediaFileId);
      streamInfo = file?.streamInfo ?? opts.streamInfo;
    }

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
      styled: t.styled,
      burnIn: burnsIn(t, false),
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
      playbackMode: 'transcode',
      subtitles: subtitleInfos,
      qualities,
      audioTracks,
      activeQualityId,
      activeSubtitleId: startSubtitle?.id ?? null,
      activeAudioStreamIndex: audioIndex,
    });

    if (!(await this.dispatchLoad(opts.mediaFileId, pi, startTime, activeQualityId, castInfo, opts.autoplay ?? true))) {
      // Nothing is playing: drop the dead overlay (and its transcode) so a new cast starts clean.
      this.clear();
    }
  }
}
