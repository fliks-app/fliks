import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../auth.service';
import { ServerConfigService } from '../server-config.service';
import { CastService } from '../cast.service';
import { CACHE_BYPASS_HEADER } from '../../interceptors/cache.interceptor';
import {
  BrowserDeviceProfileService,
  DeviceProfile,
} from '../browser-device-profile.service';

export type PlayMethod = 'DirectPlay' | 'DirectStream' | 'Transcode';

export interface PlaybackInfoResponse {
  mediaFileId: number;
  playMethod: PlayMethod;
  playUrl: string;
  contentType: string;
  transcodeReasons: { flag: string; message: string }[];
  videoCopyStream: boolean;
  audioCopyStream: boolean;
  outputVideoCodec: string;
  outputAudioCodec: string;
  outputContainer: string;
  hwAccel: string;
  tonemapping: boolean;
  /** Resolved tone-mapping filter the backend will actually use
   *  (`'auto'` resolves to opencl or vaapi depending on the boot
   *  probe). Null when no tone-mapping pass runs on this session. */
  tonemapAlgo?: 'vaapi' | 'opencl' | 'qsv' | null;
  /** Cibles par rung (transcodage). */
  transcodeBitrateByQuality?: Record<
    string,
    {
      videoBitrateBps: number;
      audioBitrateBps: number;
      /** = BANDWIDTH dans master.m3u8 pour cette variante (vidéo + audio) */
      totalBitrateBps: number;
    }
  >;
  /** BANDWIDTH variante remux (DirectStream HLS), aligné serveur / manifeste */
  remuxMasterBandwidthBps?: number;
  /** Server-authoritative quality list (device-aware ladder + Original rule). */
  qualities?: {
    id: string;
    label: string;
    height: number;
    totalBitrateBps: number;
    isRemux: boolean;
    lowBandwidth?: boolean;
  }[];
  source: {
    container: string;
    videoCodec: string;
    videoProfile?: string;
    videoLevel?: number;
    videoBitRate?: number;
    /** ffprobe format.bit_rate (conteneur) quand les flux n’ont pas de bit_rate */
    formatBitRate?: number;
    videoBitDepth?: number;
    width?: number;
    height?: number;
    frameRate?: string;
    audioCodec: string;
    audioChannels?: number;
    audioChannelLayout?: string;
    audioBitRate?: number;
    audioSampleRate?: number;
    audioLanguage?: string;
    durationSeconds?: number;
    hdrFormat?: string;
    colorSpace?: string;
    colorTransfer?: string;
    colorPrimaries?: string;
    crop?: { width: number; height: number; x: number; y: number };
  };
  /** Episode-level skip markers — only present for series episodes. */
  markers?: {
    intro?: { startSeconds: number; endSeconds: number };
    outro?: { startSeconds: number; endSeconds: number };
  };
  /** Embedded chapters from the container (MKV/MP4). */
  chapters?: { startSeconds: number; endSeconds: number; title?: string }[];
  /** Server-issued live-session identifier. The client embeds it in every
   *  subsequent `PUT /api/playback/media/:id/state` (heartbeat) and on
   *  the `DELETE /api/stream/:mediaFileId/sessions` unload signal so the
   *  backend can match the client back to its in-memory session record. */
  sessionId?: string;
  /** Profile hash this session's transcode cache is keyed under, or
   *  `null` for DirectPlay. Surfaced for the admin dashboard and for
   *  future multi-device match logic; not required by the player. */
  profileHash?: string | null;
}

export type LivePlaybackState = 'playing' | 'paused' | 'buffering';

export interface MediaResumeInfo {
  mediaFileId: number;
  episodeId: number | null;
  positionSeconds: number;
  durationSeconds: number;
  seasonNumber?: number;
  episodeNumber?: number;
}

export interface PlaybackState {
  id: number;
  mediaId: number;
  mediaFileId: number;
  episodeId: number | null;
  positionSeconds: number;
  durationSeconds: number;
  completed: boolean;
  lastPlayedAt: string;
}

/**
 * Response from the heartbeat endpoint (PUT /playback/media/:id/state).
 * `sessionLost: true` means the carried `sid` is no longer known to
 * the backend (restart, GC, …) — caller must re-issue `playback-info`
 * and reload the stream URL with the fresh sid. `state` carries the
 * persisted PlaybackState row when the call flushed to the DB
 * (debounced); the field is omitted on a no-op tick.
 */
export interface HeartbeatResponse {
  sessionLost?: true;
  state?: PlaybackState;
}

export interface WatchHistoryItem {
  id: number;
  mediaId: number;
  mediaFileId: number;
  episodeId: number | null;
  positionSeconds: number;
  durationSeconds: number;
  progressPercent: number;
  completed: boolean;
  lastPlayedAt: string;
  mediaTitle: string;
  mediaType: string;
  posterUrl: string | null;
  fanartUrl: string | null;
  /** Episode still — null for movies or when TMDB had no still. */
  stillUrl: string | null;
  episodeLabel: string | null;
}

export interface RecommendationItem {
  media: {
    id: number;
    title: string;
    type: string;
    year: number;
    posterUrl: string | null;
    /** Primary fanart, exposed so the home page can include
     *  recommended titles in its background-image pool. */
    fanartUrl: string | null;
    /** Extra fanarts variants — same role as on {@link Media}. */
    additionalFanartUrls: string[];
    genres: string[];
    /** False when the recommendation is requested-but-not-yet-downloaded
     *  (no files / no episodes on disk). Drives the missing-files cross
     *  overlay on the home recommendations row. */
    available: boolean;
  };
  becauseTitle: string;
  score: number;
}

export interface ContinueWatchingItem {
  id: number;
  mediaId: number;
  mediaFileId: number;
  episodeId: number | null;
  positionSeconds: number;
  durationSeconds: number;
  progressPercent: number;
  lastPlayedAt: string;
  mediaTitle: string;
  mediaType: string;
  posterUrl: string | null;
  fanartUrl: string | null;
  stillUrl: string | null;
  episodeLabel: string | null;
}

@Injectable({ providedIn: 'root' })
export class StreamingApiService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly castService = inject(CastService);
  private readonly deviceProfileService = inject(BrowserDeviceProfileService);

  /**
   * Token embedded into every streaming URL (manifest, segment, subtitle,
   * thumbnail). Prefers the long-lived (12h) stream token when present —
   * playback engines bake the URL at \`load()\` and can't be refreshed
   * mid-stream, so a film longer than the 1h access-token TTL would
   * break otherwise. Falls back to the access token before the player
   * has had a chance to call \`AuthService.ensureStreamToken()\` (e.g.
   * a thumbnail fetched from a list view).
   */
  private get playbackToken(): string | null {
    return this.auth.streamToken() ?? this.auth.accessToken;
  }

  /**
   * Build authenticated HLS master playlist URL.
   * `startQuality` tells the backend which quality to pre-start FFmpeg at
   * (e.g. "1080p") — avoids the "first segment fetch spawns FFmpeg at a
   * wrong variant Shaka probed during load" waste. `sessionId` is the
   * live-session handle the backend issued from `playback-info`; baking
   * it into this URL makes the master playlist propagate `?sid=...` into
   * every variant + segment URL so segment fetches route to the exact
   * `(file, user, profileHash)` transcode session.
   */
  getHlsUrl(
    mediaFileId: number,
    startQuality?: string,
    startAt?: number,
    sessionId?: string,
  ): string {
    const base = this.serverConfig.isNative
      ? this.serverConfig.resolveUrl(`/api/stream/${mediaFileId}/master.m3u8`)
      : `/api/stream/${mediaFileId}/master.m3u8`;
    const params: string[] = [];
    const token = this.playbackToken;
    if (token) params.push(`token=${encodeURIComponent(token)}`);
    if (sessionId) params.push(`sid=${encodeURIComponent(sessionId)}`);
    if (startQuality) params.push(`startQuality=${encodeURIComponent(startQuality)}`);
    if (startAt != null) params.push(`startAt=${startAt}`);
    params.push(`device=${this.deviceProfileService.getProfile().deviceType}`);
    return params.length ? `${base}?${params.join('&')}` : base;
  }

  /** Build authenticated stream URL for direct play */
  getStreamUrl(mediaFileId: number, sessionId?: string): string {
    const base = this.serverConfig.isNative
      ? this.serverConfig.resolveUrl(`/api/stream/${mediaFileId}`)
      : `/api/stream/${mediaFileId}`;
    const url = this.withTokenAndSid(base, sessionId);
    return url;
  }

  /** Internal helper for getStreamUrl — keeps the token+sid query
   *  composition consistent with `getHlsUrl`. */
  private withTokenAndSid(base: string, sessionId?: string): string {
    const params: string[] = [];
    const token = this.playbackToken;
    if (token) params.push(`token=${encodeURIComponent(token)}`);
    if (sessionId) params.push(`sid=${encodeURIComponent(sessionId)}`);
    return params.length ? `${base}?${params.join('&')}` : base;
  }

  /** Build authenticated subtitle URL */
  getSubtitleUrl(mediaFileId: number, subtitleId: number): string {
    const base = this.serverConfig.isNative
      ? this.serverConfig.resolveUrl(`/api/stream/${mediaFileId}/subtitles/${subtitleId}`)
      : `/api/stream/${mediaFileId}/subtitles/${subtitleId}`;
    const token = this.playbackToken;
    return token ? `${base}?token=${encodeURIComponent(token)}` : base;
  }

  /** Build authenticated thumbnail sprite image URL */
  getThumbnailSpriteUrl(mediaFileId: number): string {
    const base = this.serverConfig.isNative
      ? this.serverConfig.resolveUrl(`/api/stream/${mediaFileId}/thumbnails/sprite.jpg`)
      : `/api/stream/${mediaFileId}/thumbnails/sprite.jpg`;
    const token = this.playbackToken;
    return token ? `${base}?token=${encodeURIComponent(token)}` : base;
  }

  /** Build authenticated thumbnail sprite metadata URL */
  getThumbnailMetadataUrl(mediaFileId: number): string {
    const base = this.serverConfig.isNative
      ? this.serverConfig.resolveUrl(`/api/stream/${mediaFileId}/thumbnails/sprite.json`)
      : `/api/stream/${mediaFileId}/thumbnails/sprite.json`;
    const token = this.playbackToken;
    return token ? `${base}?token=${encodeURIComponent(token)}` : base;
  }

  /** Build authenticated embedded subtitle URL */
  getEmbeddedSubtitleUrl(mediaFileId: number, streamIndex: number): string {
    const base = this.serverConfig.isNative
      ? this.serverConfig.resolveUrl(`/api/stream/${mediaFileId}/subtitles/embedded/${streamIndex}`)
      : `/api/stream/${mediaFileId}/subtitles/embedded/${streamIndex}`;
    const token = this.playbackToken;
    return token ? `${base}?token=${encodeURIComponent(token)}` : base;
  }

  /** URLs absolues pour pistes Cast : base issue de cast-info (reloadCastStream). */
  private absoluteUrl(path: string): string {
    const base = this.castService.castStreamBaseUrl();
    let out: string;
    if (base) out = `${base}${path}`;
    else if (this.serverConfig.isNative) out = this.serverConfig.resolveUrl(path);
    else out = `${window.location.origin}${path}`;
    return out;
  }

  private appendToken(url: string, token: string): string {
    return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
  }

  private appendSid(url: string, sid: string | undefined): string {
    if (!sid) return url;
    return `${url}${url.includes('?') ? '&' : '?'}sid=${encodeURIComponent(sid)}`;
  }

  private withToken(url: string): string {
    const token = this.playbackToken;
    return token ? this.appendToken(url, token) : url;
  }

  /** Build Cast URLs with a temporary token. `sessionId` is the live
   *  session handle the Cast device received from its own `playback-info`
   *  call; baking it here propagates the same sid into the variant +
   *  segment URLs so segments route to the Cast-specific transcode job. */
  getAbsoluteHlsUrl(
    mediaFileId: number,
    castToken: string,
    sessionId?: string,
  ): string {
    return this.appendSid(
      this.appendToken(
        this.absoluteUrl(`/api/stream/${mediaFileId}/master.m3u8`),
        castToken,
      ),
      sessionId,
    );
  }

  getAbsoluteStreamUrl(
    mediaFileId: number,
    castToken: string,
    sessionId?: string,
  ): string {
    return this.appendSid(
      this.appendToken(
        this.absoluteUrl(`/api/stream/${mediaFileId}`),
        castToken,
      ),
      sessionId,
    );
  }

  getAbsoluteSubtitleUrl(mediaFileId: number, subtitleId: number, castToken: string): string {
    return this.appendToken(this.absoluteUrl(`/api/stream/${mediaFileId}/subtitles/${subtitleId}`), castToken);
  }

  getAbsoluteEmbeddedSubtitleUrl(mediaFileId: number, streamIndex: number, castToken: string): string {
    return this.appendToken(this.absoluteUrl(`/api/stream/${mediaFileId}/subtitles/embedded/${streamIndex}`), castToken);
  }

  getHwAccelInfo() {
    return firstValueFrom(
      this.http.get<{ hwAccel: string }>('/api/stream/info/hw-accel'),
    );
  }

  /**
   * Ask the backend to decide how to play this file based on client capabilities.
   * `startQuality` / `startAt` let the backend pre-spawn ffmpeg at the right
   * variant straight from this call (saves the master.m3u8 round-trip).
   */
  getPlaybackInfo(
    mediaFileId: number,
    deviceProfile: DeviceProfile,
    burnInSubtitleId?: number,
    audioStreamIndex?: number,
    startQuality?: string,
    startAt?: number,
  ): Promise<PlaybackInfoResponse> {
    const token = this.playbackToken;
    let params = token ? `?token=${encodeURIComponent(token)}` : '';
    if (burnInSubtitleId) {
      params += (params ? '&' : '?') + `burnInSubtitleId=${burnInSubtitleId}`;
    }
    if (audioStreamIndex != null) {
      params += (params ? '&' : '?') + `audioStreamIndex=${audioStreamIndex}`;
    }
    if (startQuality) {
      params += (params ? '&' : '?') + `startQuality=${encodeURIComponent(startQuality)}`;
    }
    if (startAt != null) {
      params += (params ? '&' : '?') + `startAt=${startAt}`;
    }
    return firstValueFrom(
      this.http.post<PlaybackInfoResponse>(
        `/api/stream/${mediaFileId}/playback-info${params}`,
        deviceProfile,
      ),
    );
  }

  /** Build the URL for stopping sessions (used with fetch(keepalive) on unload).
   *  Prefer the sid-scoped variant when a sessionId is available — the
   *  bulk path kills every profile for the (user, file) pair, which
   *  would tear down other devices watching the same title. */
  getStopSessionsUrl(mediaFileId: number, sessionId?: string): string {
    if (sessionId) {
      const path = `/api/stream/sessions/${encodeURIComponent(sessionId)}`;
      const base = this.serverConfig.isNative
        ? this.serverConfig.resolveUrl(path)
        : path;
      const token = this.playbackToken;
      return token ? `${base}?token=${encodeURIComponent(token)}` : base;
    }
    const base = this.serverConfig.isNative
      ? this.serverConfig.resolveUrl(`/api/stream/${mediaFileId}/sessions`)
      : `/api/stream/${mediaFileId}/sessions`;
    const token = this.playbackToken;
    return token ? `${base}?token=${encodeURIComponent(token)}` : base;
  }

  stopSessions(mediaFileId: number, sessionId?: string) {
    if (sessionId) {
      return firstValueFrom(
        this.http.delete(
          `/api/stream/sessions/${encodeURIComponent(sessionId)}`,
        ),
      );
    }
    return firstValueFrom(
      this.http.delete(`/api/stream/${mediaFileId}/sessions`),
    );
  }

  getWatchedEpisodeIds(mediaId: number) {
    return firstValueFrom(
      this.http.get<number[]>(`/api/playback/media/${mediaId}/watched-episodes`),
    );
  }

  getEpisodeProgress(mediaId: number) {
    return firstValueFrom(
      this.http.get<Record<number, number>>(
        `/api/playback/media/${mediaId}/episode-progress`,
      ),
    );
  }

  getMediaResumeInfo(mediaId: number) {
    return firstValueFrom(
      this.http.get<MediaResumeInfo | null>(`/api/playback/media/${mediaId}`),
    );
  }

  getPlaybackState(mediaId: number, episodeId?: number) {
    const params = episodeId ? `?episodeId=${episodeId}` : '';
    return firstValueFrom(
      this.http.get<PlaybackState | null>(`/api/playback/media/${mediaId}/state${params}`),
    );
  }

  updatePlaybackState(
    mediaId: number,
    body: {
      positionSeconds: number;
      durationSeconds: number;
      mediaFileId: number;
      episodeId?: number;
      // Live-session heartbeat fields. Only present once the player has
      // received a `sessionId` from `getPlaybackInfo`; the backend
      // tolerates their absence (legacy / unauthenticated paths).
      sessionId?: string;
      state?: LivePlaybackState;
      quality?: string | null;
      audioTrackIndex?: number | null;
      subtitleTrackIndex?: number | null;
    },
  ) {
    return firstValueFrom(
      this.http.put<HeartbeatResponse | null>(
        `/api/playback/media/${mediaId}/state`,
        body,
      ),
    );
  }

  getContinueWatching(libraryId?: number, opts: { force?: boolean } = {}) {
    const reqOpts: { params?: { libraryId: string }; headers?: { [k: string]: string } } = {};
    if (libraryId) reqOpts.params = { libraryId: String(libraryId) };
    if (opts.force) reqOpts.headers = { [CACHE_BYPASS_HEADER]: '1' };
    return firstValueFrom(
      this.http.get<ContinueWatchingItem[]>(
        '/api/playback/continue-watching',
        reqOpts,
      ),
    );
  }

  getRecommendations(
    opts: { libraryId?: number; limit?: number; force?: boolean } = {},
  ) {
    const params: Record<string, string> = {};
    if (opts.libraryId) params['libraryId'] = String(opts.libraryId);
    if (opts.limit) params['limit'] = String(opts.limit);
    const reqOpts: {
      params?: Record<string, string>;
      headers?: { [k: string]: string };
    } = {};
    if (Object.keys(params).length) reqOpts.params = params;
    if (opts.force) reqOpts.headers = { [CACHE_BYPASS_HEADER]: '1' };
    return firstValueFrom(
      this.http.get<RecommendationItem[]>(
        '/api/playback/recommendations',
        reqOpts,
      ),
    );
  }

  /** Persist a "remove from recommendations" gesture. Idempotent. */
  dismissRecommendation(mediaId: number) {
    return firstValueFrom(
      this.http.post<void>(`/api/playback/recommendations/${mediaId}/dismiss`, {}),
    );
  }

  countDismissedRecommendations() {
    return firstValueFrom(
      this.http.get<{ count: number }>('/api/playback/recommendations/dismissed/count'),
    );
  }

  /** Wipes every dismissal for the current user. Returns the number removed. */
  resetDismissedRecommendations() {
    return firstValueFrom(
      this.http.delete<{ removed: number }>('/api/playback/recommendations/dismissed'),
    );
  }

  getHistory(page = 1, limit = 25, opts: { force?: boolean } = {}) {
    const reqOpts: {
      params: Record<string, string>;
      headers?: { [k: string]: string };
    } = { params: { page: String(page), limit: String(limit) } };
    if (opts.force) reqOpts.headers = { [CACHE_BYPASS_HEADER]: '1' };
    return firstValueFrom(
      this.http.get<{ data: WatchHistoryItem[]; total: number }>('/api/playback/history', reqOpts),
    );
  }

  deletePlaybackState(mediaId: number, episodeId?: number) {
    const params = episodeId ? `?episodeId=${episodeId}` : '';
    return firstValueFrom(
      this.http.delete<void>(`/api/playback/media/${mediaId}/state${params}`),
    );
  }

  getWatchedMediaIds(opts: { force?: boolean } = {}): Promise<number[]> {
    const headers = opts.force ? { [CACHE_BYPASS_HEADER]: '1' } : undefined;
    return firstValueFrom(
      this.http.get<number[]>('/api/playback/watched-ids', headers ? { headers } : {}),
    );
  }

  toggleWatched(mediaId: number, mediaFileId: number, episodeId?: number) {
    return firstValueFrom(
      this.http.post<PlaybackState>(`/api/playback/media/${mediaId}/toggle-watched`, { mediaFileId, episodeId }),
    );
  }

  /**
   * Mark every episode of a series as watched/unwatched in a single request.
   * The caller should refresh the episode watched list after this.
   */
  toggleSeriesWatched(mediaId: number, watched: boolean) {
    return firstValueFrom(
      this.http.post<{ watched: boolean }>(
        `/api/playback/media/${mediaId}/toggle-series-watched`,
        { watched },
      ),
    );
  }

  toggleSeasonWatched(mediaId: number, seasonId: number, watched: boolean) {
    return firstValueFrom(
      this.http.post<{ watched: boolean }>(
        `/api/playback/media/${mediaId}/seasons/${seasonId}/toggle-watched`,
        { watched },
      ),
    );
  }

  hideFromContinueWatching(mediaId: number) {
    return firstValueFrom(
      this.http.delete<void>(`/api/playback/hide/${mediaId}`),
    );
  }

  getDownloadQualities(mediaFileId: number) {
    return firstValueFrom(
      this.http.get<DownloadQuality[]>(`/api/stream/info/qualities/${mediaFileId}`),
    );
  }

  /** HDR→SDR tone-mapping algorithms the server can actually run.
   *  Drives the admin streaming-settings dropdown so platforms / hosts
   *  that lack a given filter graph (no OpenCL stack, no Intel iGPU, …)
   *  don't get to pick an option that would fail at session time. */
  getTonemapAlgos() {
    return firstValueFrom(
      this.http.get<{ available: string[] }>('/api/stream/info/tonemap-algos'),
    );
  }
}

export interface DownloadQuality {
  key: string;
  label: string;
  estimatedSize: number;
}
