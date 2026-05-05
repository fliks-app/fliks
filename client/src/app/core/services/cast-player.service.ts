import { Injectable, inject, signal } from '@angular/core';
import { CastService } from './cast.service';
import { CastSettingsService } from './cast-settings.service';
import { StreamingApiService } from './api/streaming-api.service';
import { SubtitlesApiService } from './api/subtitles-api.service';
import { AuthService } from './auth.service';
import { DeviceProfile } from './browser-device-profile.service';
import { ServerConfigService } from './server-config.service';
import { formatAudioLabel, parseAudioIndex, SpriteMetadata } from '../utils/player.utils';
import { PlayerSettingsService } from './player-settings.service';
import { TrackManagerService } from './track-manager.service';
import { MediaService } from './api/media.service';

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
): CastAudioOption[] {
  if (!audioStreams?.length) return [];
  return audioStreams.map((a, i) => {
    const lang = a.language ?? 'und';
    return {
      id: `audio-${i}`,
      label: formatAudioLabel(a),
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
  qualities: { id: string; label: string; height: number }[] | undefined,
  maxQuality: string | undefined,
): CastQualityOption[] {
  if (!qualities?.length) return [];
  const heightCap =
    maxQuality && maxQuality !== 'original'
      ? parseInt(maxQuality, 10) || Infinity
      : Infinity;
  return qualities
    .filter(q => q.id !== 'original' && q.height <= heightCap)
    .map(q => ({ id: q.id, label: q.label }));
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
  private readonly authService = inject(AuthService);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly playerSettings = inject(PlayerSettingsService);
  private readonly trackManager = inject(TrackManagerService);
  private readonly mediaService = inject(MediaService);

  /** Chromecast profile — force full transcode to guarantee H264+AAC HLS output. */
  private getCastDeviceProfile(): DeviceProfile {
    const cs = this.castSettings.get();
    return {
      // Empty direct play profiles → nothing can direct play or remux → always transcode
      directPlayProfiles: [],
      codecConditions: [],
      maxStreamingBitrate: 20_000_000,
      maxAudioChannels: cs.audioChannels ?? 2,
      supportsHdr: cs.hdr ?? false,
      deviceType: 'desktop',
    };
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

  /** Clear Cast media state (on disconnect/stop). Saves position first. */
  clear() {
    this.saveCastPosition(); // Save final position before clearing
    this.stopPositionSaving();
    this.hasMedia.set(false);
    this.expanded.set(false);
    this.mediaFileId.set(0);
    this.spriteUrl.set(null);
    this.spriteMetadata.set(null);
  }

  /**
   * Reload the Cast stream after a quality / audio / burn-in change.
   * Drops any in-flight ffmpeg session before re-spawning, since the new
   * audio/burn-in context wouldn't be picked up by an existing session
   * (transcoding.service only auto-replaces on quality change).
   */
  async reloadCastStream(positionOverride?: number) {
    const mfId = this.mediaFileId();
    if (!mfId) return;

    await this.streamingApi.stopSessions(mfId).catch(() => {});

    const currentPos = positionOverride ?? this.cast.currentTime();
    const audioIdx = this.activeAudioStreamIndex
      ?? parseAudioIndex(this.activeAudioTrackId() ?? 'audio-0');
    const transcodeQuality = this.resolveTranscodeQuality(this.activeQualityId());

    // Parallel: playback-info (triggers backend prewarm) + cast token fetch.
    const castProfile = this.getCastDeviceProfile();
    const [pi, castInfo] = await Promise.all([
      this.streamingApi.getPlaybackInfo(
        mfId, castProfile, this.activeBurnInId ?? undefined, audioIdx,
        transcodeQuality, Math.floor(currentPos),
      ),
      this.authService.getCastInfo(),
    ]);

    await this.dispatchLoad(mfId, pi, currentPos, transcodeQuality, castInfo);
  }

  /**
   * Resolve the concrete transcode profile name from the active quality id.
   * The cast quality list is built without 'auto' / 'original' rungs (cast
   * forces transcode), so the active id is normally concrete. Defensive
   * fallback to '1080p' for any stray sentinel.
   */
  private resolveTranscodeQuality(qualityId: string): string {
    if (qualityId === 'auto' || qualityId === 'original') return '1080p';
    return qualityId;
  }

  /**
   * Build the cast URL from a playback-info response and dispatch loadMedia.
   * Shared between quickStart (initial cast) and reloadCastStream (changes).
   */
  private async dispatchLoad(
    mfId: number,
    pi: { playMethod: string },
    currentPos: number,
    transcodeQuality: string | undefined,
    castInfo: { token: string; streamBaseUrl: string },
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
    if (castMode === 'direct') {
      castUrl = this.streamingApi.getAbsoluteStreamUrl(mfId, castToken);
      contentType = 'video/mp4';
    } else if (castMode === 'remux') {
      castUrl = `${lanUrl}/api/stream/${mfId}/master.m3u8?token=${tokenQ}&remux=1${startAtParam}`;
      contentType = 'application/x-mpegurl';
    } else {
      const q = transcodeQuality ?? '1080p';
      castUrl = `${lanUrl}/api/stream/${mfId}/master.m3u8?token=${tokenQ}&startQuality=${q}${startAtParam}`;
      contentType = 'application/x-mpegurl';
    }

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
    // on the standard media bus. Sub-100ms swap, no ffmpeg restart. Native
    // Cast plugin falls through to a full reload.
    const audio = this.availableAudioTracks()[audioIndex];
    if (audio && this.cast.setActiveAudioLanguage(audio.language, audio.name)) {
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
      await this.streamingApi.updatePlaybackState(mId, {
        positionSeconds: pos,
        durationSeconds: dur || 0,
        mediaFileId: mfId,
        episodeId: this.episodeId(),
      });
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

    // Build subtitle list from the parallel fetch
    const subtitleInfos: SubtitleInfo[] = [];
    const bitmapCodecs = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle']);
    for (const sub of subsResult) {
      if (sub.mediaFileId !== opts.mediaFileId) continue;
      const isBitmap = bitmapCodecs.has(sub.codec ?? '');
      if (sub.relativePath) {
        subtitleInfos.push({
          id: `ext-${sub.id}`, label: `${sub.language}${sub.forced ? ' (Forced)' : ''}`,
          language: sub.language, burnIn: false, subtitleDbId: sub.id,
          url: this.streamingApi.getSubtitleUrl(opts.mediaFileId, sub.id),
          forced: sub.forced ?? false,
        });
      } else if (sub.streamIndex != null) {
        subtitleInfos.push({
          id: `emb-${sub.streamIndex}`,
          label: `${sub.language}${sub.forced ? ' (Forced)' : ''}${isBitmap ? ' [PGS]' : ' [embedded]'}`,
          language: sub.language, burnIn: isBitmap, subtitleDbId: sub.id,
          url: isBitmap ? '' : this.streamingApi.getEmbeddedSubtitleUrl(opts.mediaFileId, sub.streamIndex!),
          forced: sub.forced ?? false,
        });
      }
    }

    const audioTracks = buildCastAudioOptions(streamInfo?.audio);

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

    await this.dispatchLoad(opts.mediaFileId, pi, startTime, activeQualityId, castInfo);
  }
}
