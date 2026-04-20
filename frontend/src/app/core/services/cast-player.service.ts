import { Injectable, inject, signal } from '@angular/core';
import { CastService } from './cast.service';
import { CastSettingsService } from './cast-settings.service';
import { StreamingApiService } from './api/streaming-api.service';
import { SubtitlesApiService } from './api/subtitles-api.service';
import { AuthService } from './auth.service';
import { BrowserDeviceProfileService, DeviceProfile } from './browser-device-profile.service';
import { ServerConfigService } from './server-config.service';
import { parseAudioIndex, SpriteMetadata } from '../utils/player.utils';
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
  language?: string;
}

export interface CastQualityOption {
  id: string;
  label: string;
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
  private readonly deviceProfile = inject(BrowserDeviceProfileService);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly playerSettings = inject(PlayerSettingsService);
  private readonly trackManager = inject(TrackManagerService);
  private readonly mediaService = inject(MediaService);

  /** Chromecast device profile — only H264 + AAC, forces transcode for incompatible codecs. */
  /** Chromecast profile — force full transcode to guarantee H264+AAC HLS output. */
  private getCastDeviceProfile(): DeviceProfile {
    const cs = this.castSettings.get();
    return {
      // Empty direct play profiles → nothing can direct play or remux → always transcode
      directPlayProfiles: [],
      codecConditions: [],
      maxStreamingBitrate: 20_000_000,
      maxAudioChannels: cs.audioChannels ?? 2,
      supportsHlsFmp4: false,  // Default Cast receiver (MPL) doesn't support fMP4 HLS
      supportsHlsTs: true,
      supportsHdr: cs.hdr ?? false,
      hdrRequiresFmp4: false,  // Cast uses TS — HDR will be tonemapped if needed
      supportsMultiAudioMuxed: false,
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

  async reloadCastStream(positionOverride?: number) {
    const mfId = this.mediaFileId();
    if (!mfId) return;

    // Kill any existing session — Cast uses TS while desktop uses fMP4.
    await this.streamingApi.stopSessions(mfId).catch(() => {});

    const castProfile = this.getCastDeviceProfile();

    // Resolve audio index from active track ID if not explicitly set
    const audioIdx = this.activeAudioStreamIndex
      ?? parseAudioIndex(this.activeAudioTrackId() ?? 'audio-0');

    const pi = await this.streamingApi.getPlaybackInfo(
      mfId, castProfile, this.activeBurnInId ?? undefined, audioIdx,
    );

    // Update playback mode from backend decision (may differ from local player)
    const castMode: 'direct' | 'remux' | 'transcode' =
      pi.playMethod === 'DirectPlay' ? 'direct' :
      pi.playMethod === 'DirectStream' ? 'remux' : 'transcode';
    this.playbackMode.set(castMode);

    const currentPos = positionOverride ?? this.cast.currentTime();
    const qualityId = this.activeQualityId();

    let transcodeQuality: string | undefined;
    if (castMode === 'transcode') {
      if (qualityId !== 'auto' && qualityId !== 'original') {
        transcodeQuality = qualityId;
      } else {
        const cs = this.castSettings.get();
        const maxQ = cs.maxQuality;
        const qualities = this.availableQualities().filter(q => q.id !== 'auto' && q.id !== 'original');
        if (maxQ === 'original') {
          transcodeQuality = qualities[0]?.id ?? '1080p';
        } else {
          transcodeQuality = qualities.find(q => q.id === maxQ)?.id ?? qualities[0]?.id ?? '1080p';
        }
      }
    }

    // Token + base URL le plus tard possible avant loadMedia (expiration du token Cast).
    const { token: castToken, streamBaseUrl } = await this.authService.getCastInfo();
    this.cast.setCastStreamBase(streamBaseUrl);
    const fromServer = streamBaseUrl.replace(/\/+$/, '');
    const lanUrl =
      fromServer ||
      (this.serverConfig.isNative
        ? this.serverConfig.serverUrl()
        : window.location.origin);

    let castUrl: string;
    let contentType: string;
    if (castMode === 'direct') {
      castUrl = this.streamingApi.getAbsoluteStreamUrl(mfId, castToken);
      contentType = 'video/mp4';
    } else if (castMode === 'remux') {
      castUrl = `${lanUrl}/api/stream/${mfId}/remux/index.m3u8?token=${encodeURIComponent(castToken)}&copyAudio=false&startAt=${Math.floor(currentPos)}`;
      contentType = 'application/x-mpegurl';
    } else {
      const q = transcodeQuality ?? '1080p';
      castUrl = `${lanUrl}/api/stream/${mfId}/${q}/index.m3u8?token=${encodeURIComponent(castToken)}&startAt=${Math.floor(currentPos)}`;
      contentType = 'application/x-mpegurl';
    }

    // Build subtitle list (only non-burn-in sidecar, absolute URLs)
    const subtitles = this.subtitleInfos
      .filter(s => !s.burnIn && s.subtitleDbId)
      .map(s => ({
        url: s.id.startsWith('ext-')
          ? this.streamingApi.getAbsoluteSubtitleUrl(mfId, s.subtitleDbId!, castToken)
          : this.streamingApi.getAbsoluteEmbeddedSubtitleUrl(mfId, parseInt(s.id.replace('emb-', ''), 10), castToken),
        language: s.language,
        label: s.label,
      }));

    // Find active subtitle track ID for Cast (1-based)
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
    });
  }

  async changeQuality(qualityId: string) {
    this.activeQualityId.set(qualityId);
    await this.reloadCastStream();
  }

  async changeAudio(audioIndex: number) {
    this.activeAudioStreamIndex = audioIndex;

    // Save selection via shared TrackManager
    const trackId = `audio-${audioIndex}`;
    this.trackManager.saveAudioSelection(
      trackId, this.availableAudioTracks(), this.mediaId(), 0,
    );

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

  /** Resolve the initial Cast quality from Cast settings (maxQuality). */
  private resolveInitialCastQuality(qualities: CastQualityOption[]): string {
    const cs = this.castSettings.get();
    const maxQ = cs.maxQuality;
    const filtered = qualities.filter(q => q.id !== 'auto' && q.id !== 'original');
    if (maxQ === 'original') {
      return filtered[0]?.id ?? '1080p';
    }
    return filtered.find(q => q.id === maxQ)?.id ?? filtered[0]?.id ?? '1080p';
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
    const castProfile = this.getCastDeviceProfile();

    // Fetch media info if streamInfo not provided (e.g. from "Continue Watching")
    let streamInfo = opts.streamInfo;
    let fanartUrl = opts.fanartUrl ?? null;
    if (!streamInfo) {
      try {
        const media = await this.mediaService.getOne(opts.mediaId);
        const file = media.files?.find((f: any) => f.id === opts.mediaFileId);
        streamInfo = file?.streamInfo;
        if (!fanartUrl && media.fanartUrl) fanartUrl = media.fanartUrl;
      } catch { /* ignore — will proceed without streamInfo */ }
    }
    // Resolve relative URLs to absolute (needed on mobile where origin is localhost)
    if (fanartUrl) fanartUrl = this.serverConfig.resolveUrl(fanartUrl);

    // Resolve preferred audio stream index from user settings
    const audioStreams: { language?: string }[] = streamInfo?.audio ?? [];
    const audioIndex = this.playerSettings.resolveAudioStreamIndex(
      opts.mediaFileId, audioStreams, opts.mediaId,
    );

    // Fetch playback info
    const pi = await this.streamingApi.getPlaybackInfo(opts.mediaFileId, castProfile, undefined, audioIndex);
    const mode: 'direct' | 'remux' | 'transcode' =
      pi.playMethod === 'DirectPlay' ? 'direct' :
      pi.playMethod === 'DirectStream' ? 'remux' : 'transcode';

    // Build quality options from source resolution
    const srcW = pi.source.width ?? 1920;
    const srcH = pi.source.height ?? 1080;
    const profiles = [
      { id: '1080p', label: '1080p', minWidth: 1920 },
      { id: '720p', label: '720p', minWidth: 1280 },
      { id: '480p', label: '480p', minWidth: 854 },
      { id: '360p', label: '360p', minWidth: 640 },
    ];
    const qualities: CastQualityOption[] = [];
    if (pi.videoCopyStream) {
      qualities.push({ id: 'original', label: `${srcH}p` });
    }
    for (const p of profiles) {
      if (srcW >= p.minWidth) qualities.push(p);
    }

    // Fetch subtitles
    const subtitleInfos: SubtitleInfo[] = [];
    const bitmapCodecs = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle']);
    try {
      const subs = await this.subtitlesApi.getForMedia(opts.mediaId);
      for (const sub of subs) {
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
    } catch { /* ignore */ }

    // Build audio tracks from streamInfo
    const audioTracks: CastAudioOption[] = [];
    const si = streamInfo;
    if (si?.audio?.length) {
      for (let i = 0; i < si.audio.length; i++) {
        const a = si.audio[i];
        audioTracks.push({
          id: `audio-${i}`,
          label: `${a.language ?? 'und'}${a.title ? ' - ' + a.title : ''} (${(a.codec ?? '').toUpperCase()}${a.channels ? ' ' + a.channels + 'ch' : ''})`,
          language: a.language ?? 'und',
        });
      }
    }

    // Initialize state
    this.startCast({
      mediaFileId: opts.mediaFileId,
      mediaId: opts.mediaId,
      episodeId: opts.episodeId,
      mediaTitle: opts.title,
      episodeTitle: opts.episodeTitle ?? '',
      fanartUrl,
      playbackMode: mode,
      subtitles: subtitleInfos,
      qualities,
      audioTracks,
      activeQualityId: this.resolveInitialCastQuality(qualities),
      activeSubtitleId: this.resolveRememberedSubtitleId(opts.mediaId, subtitleInfos),
      activeAudioTrackId: audioIndex != null ? `audio-${audioIndex}` : (audioTracks[0]?.id ?? null),
      activeBurnInId: null,
      activeAudioStreamIndex: audioIndex,
    });

    // Resolve start position: explicit > saved playback state > 0
    let startTime = opts.startTime;
    if (startTime == null) {
      try {
        const state = await this.streamingApi.getPlaybackState(opts.mediaId, opts.episodeId);
        if (state && !state.completed && state.positionSeconds > 10) {
          startTime = state.positionSeconds;
        }
      } catch { /* ignore */ }
    }
    await this.reloadCastStream(startTime ?? 0);
  }
}
