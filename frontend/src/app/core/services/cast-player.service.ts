import { Injectable, inject, signal } from '@angular/core';
import { CastService } from './cast.service';
import { CastSettingsService } from './cast-settings.service';
import { StreamingApiService } from './api/streaming-api.service';
import { SubtitlesApiService } from './api/subtitles-api.service';
import { AuthService } from './auth.service';
import { BrowserDeviceProfileService, DeviceProfile } from './browser-device-profile.service';
import { ServerConfigService } from './server-config.service';
import { PlayerSettingsService } from './player-settings.service';

export interface CastSubtitleOption {
  id: string;
  label: string;
  language: string;
  burnIn: boolean;
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
      supportsMultiAudioMuxed: false,
    };
  }

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
    this.fanartUrl.set(opts.fanartUrl);
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
      subtitleDbId: s.subtitleDbId,
      castTrackId: s.burnIn ? s.subtitleDbId : trackId++,
    })));
    this.availableQualities.set(opts.qualities);
    this.availableAudioTracks.set(opts.audioTracks);
    this.hasMedia.set(true);
  }

  /** Clear Cast media state (on disconnect). */
  clear() {
    this.hasMedia.set(false);
    this.expanded.set(false);
    this.mediaFileId.set(0);
  }

  async reloadCastStream(positionOverride?: number) {
    const mfId = this.mediaFileId();
    if (!mfId) return;

    const castProfile = this.getCastDeviceProfile();

    const pi = await this.streamingApi.getPlaybackInfo(
      mfId, castProfile, this.activeBurnInId ?? undefined, this.activeAudioStreamIndex,
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
      // Always transcode audio for Cast (Chromecast only supports AAC)
      castUrl = `${lanUrl}/api/stream/${mfId}/remux/index.m3u8?token=${encodeURIComponent(castToken)}&copyAudio=false`;
      contentType = 'application/x-mpegurl';
    } else {
      const q = transcodeQuality ?? '1080p';
      castUrl = `${lanUrl}/api/stream/${mfId}/${q}/index.m3u8?token=${encodeURIComponent(castToken)}`;
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
    await this.reloadCastStream();
  }

  async changeBurnIn(subtitleDbId: number | null) {
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

    // Resolve preferred audio stream index from user settings
    const audioStreams: { language?: string }[] = opts.streamInfo?.audio ?? [];
    const audioIndex = this.playerSettings.resolveAudioStreamIndex(
      opts.mediaFileId, audioStreams,
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
          });
        } else if (sub.streamIndex != null) {
          subtitleInfos.push({
            id: `emb-${sub.streamIndex}`,
            label: `${sub.language}${sub.forced ? ' (Forced)' : ''}${isBitmap ? ' [PGS]' : ' [embedded]'}`,
            language: sub.language, burnIn: isBitmap, subtitleDbId: sub.id,
            url: isBitmap ? '' : this.streamingApi.getEmbeddedSubtitleUrl(opts.mediaFileId, sub.streamIndex!),
          });
        }
      }
    } catch { /* ignore */ }

    // Build audio tracks from streamInfo
    const audioTracks: CastAudioOption[] = [];
    const si = opts.streamInfo;
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
      fanartUrl: opts.fanartUrl ?? null,
      playbackMode: mode,
      subtitles: subtitleInfos,
      qualities,
      audioTracks,
      activeQualityId: 'auto',
      activeSubtitleId: null,
      activeAudioTrackId: audioIndex != null ? `audio-${audioIndex}` : (audioTracks[0]?.id ?? null),
      activeBurnInId: null,
      activeAudioStreamIndex: audioIndex,
    });

    await this.reloadCastStream(opts.startTime ?? 0);
  }
}
