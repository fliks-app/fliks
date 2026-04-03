import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  ViewEncapsulation,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { StreamingApiService } from '../../core/services/api/streaming-api.service';
import { SubtitlesApiService, SubtitleFileRow } from '../../core/services/api/subtitles-api.service';
import { MediaService, Media } from '../../core/services/api/media.service';
import { PlayerControlsComponent } from './player-controls';
import { PlayerStatsOverlayComponent, PlayerStats } from './player-stats-overlay';
import shaka from 'shaka-player';

interface SubtitleOption {
  id: string;
  label: string;
  url: string;
  language: string;
}

@Component({
  selector: 'app-player',
  imports: [TranslateModule, PlayerControlsComponent, PlayerStatsOverlayComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './player.html',
  styles: [`
    :host ::ng-deep video::cue {
      font-size: 0.9em;
      background: rgba(0, 0, 0, 0.6);
      line-height: 1.4;
    }
  `],
  encapsulation: ViewEncapsulation.None,
})
export class PlayerComponent implements AfterViewInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly streamingApi = inject(StreamingApiService);
  private readonly subtitlesApi = inject(SubtitlesApiService);
  private readonly mediaService = inject(MediaService);

  private readonly videoEl = viewChild<ElementRef<HTMLVideoElement>>('videoElement');
  private player: shaka.Player | null = null;
  private saveInterval: ReturnType<typeof setInterval> | null = null;
  private controlsTimeout: ReturnType<typeof setTimeout> | null = null;
  private statsInterval: ReturnType<typeof setInterval> | null = null;

  // State
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly paused = signal(true);
  readonly currentTime = signal(0);
  readonly duration = signal(0);
  readonly volume = signal(1);
  readonly playbackRate = signal(1);
  readonly controlsVisible = signal(true);
  readonly buffering = signal(false);
  readonly statsVisible = signal(false);
  readonly subtitlePickerOpen = signal(false);
  readonly activeSubtitleId = signal<string | null>(null);
  readonly availableSubtitles = signal<SubtitleOption[]>([]);

  // Media info
  private mediaFileId = 0;
  private mediaId = 0;
  private episodeId: number | undefined;
  private media: Media | null = null;

  readonly mediaTitle = signal('');
  readonly episodeTitle = signal('');
  readonly playbackMode = signal('direct');
  readonly hwAccel = signal('none');

  readonly playerStats = computed<PlayerStats | null>(() => {
    if (!this.statsVisible()) return null;
    const video = this.videoEl()?.nativeElement;
    if (!video) return null;

    const streamInfo = this.getStreamInfo();
    const v = streamInfo?.video?.[0];
    const a = streamInfo?.audio?.[0];

    const stats = this.player?.getStats();

    return {
      videoCodec: v?.codec ?? '?',
      resolution: v ? `${v.width}x${v.height}` : '?',
      videoBitrate: v?.bitRate ? `${(v.bitRate / 1_000_000).toFixed(1)} Mbps` : '?',
      frameRate: v?.frameRate ? `${v.frameRate} fps` : '?',
      profile: v?.profile ?? '?',
      audioCodec: a?.codec ?? '?',
      audioChannels: a?.channelLayout ?? (a?.channels ? `${a.channels}ch` : '?'),
      audioLanguage: a?.language ?? '?',
      audioBitrate: a?.bitRate ? `${(a.bitRate / 1000).toFixed(0)} kbps` : '?',
      playbackMode: this.playbackMode(),
      hwAccel: this.hwAccel(),
      bufferLength: stats?.bufferingTime ?? 0,
      droppedFrames: stats?.droppedFrames ?? 0,
      decodedFrames: stats?.decodedFrames ?? 0,
      estimatedBandwidth: stats?.estimatedBandwidth
        ? `${(stats.estimatedBandwidth / 1_000_000).toFixed(1)} Mbps`
        : '?',
      position: this.formatTime(video.currentTime),
      duration: this.formatTime(video.duration),
    };
  });

  async ngAfterViewInit() {
    shaka.polyfill.installAll();
    if (!shaka.Player.isBrowserSupported()) {
      this.error.set('Browser not supported');
      this.loading.set(false);
      return;
    }

    const qp = this.route.snapshot.queryParams;
    this.mediaFileId = +this.route.snapshot.params['mediaFileId'];
    this.mediaId = qp['mediaId'] ? +qp['mediaId'] : 0;
    this.episodeId = qp['episodeId'] ? +qp['episodeId'] : undefined;
    const resumeTime = qp['t'] ? +qp['t'] : undefined;

    const video = this.videoEl()!.nativeElement;
    this.player = new shaka.Player();
    await this.player.attach(video);

    // Video event listeners
    video.addEventListener('timeupdate', () => {
      this.currentTime.set(video.currentTime);
    });
    video.addEventListener('durationchange', () => {
      // Only use video.duration if we don't already have a reliable duration from ffprobe
      // and if the reported duration is finite and reasonable
      const current = this.duration();
      if (!current && isFinite(video.duration) && video.duration > 0) {
        this.duration.set(video.duration);
      }
    });
    video.addEventListener('play', () => this.paused.set(false));
    video.addEventListener('pause', () => this.paused.set(true));
    video.addEventListener('waiting', () => this.buffering.set(true));
    video.addEventListener('playing', () => this.buffering.set(false));
    video.addEventListener('canplay', () => this.buffering.set(false));
    video.addEventListener('volumechange', () => {
      this.volume.set(video.muted ? 0 : video.volume);
    });

    this.player.addEventListener('error', (e: any) => {
      this.error.set(e.detail?.message ?? 'Playback error');
    });

    try {
      // Load media info
      if (this.mediaId) {
        const media = await this.mediaService.getOne(this.mediaId);
        this.media = media;
        this.mediaTitle.set(media.title);
        const file = media.files?.find((f: any) => f.id === this.mediaFileId);
        const ext = file?.relativePath?.split('.').pop()?.toLowerCase();
        const si = file?.streamInfo as any;
        const videoCodec = si?.video?.[0]?.codec?.toLowerCase() ?? '';
        const directExts = new Set(['mp4', 'm4v', 'webm']);
        const directCodecs = new Set(['h264', 'avc1', 'vp8', 'vp9']);
        const canDirectPlay = directExts.has(ext ?? '') && directCodecs.has(videoCodec);
        this.playbackMode.set(canDirectPlay ? 'direct' : 'transcode');
        // Use duration from streamInfo (reliable, from ffprobe)
        const knownDuration = (file?.streamInfo as any)?.durationSeconds;
        if (knownDuration && knownDuration > 0) {
          this.duration.set(knownDuration);
        }
      }

      const mode = this.playbackMode();
      if (mode === 'transcode') {
        try {
          const info = await this.streamingApi.getHwAccelInfo();
          this.hwAccel.set(info.hwAccel);
        } catch { /* ignore */ }
      }
      console.log('[Player] mediaFileId:', this.mediaFileId, 'mediaId:', this.mediaId, 'mode:', mode, 'hw:', this.hwAccel());

      video.addEventListener('error', () => {
        const e = video.error;
        console.error('[Player] Video error:', e?.code, e?.message);
        this.error.set(e?.message ?? `Video error code ${e?.code}`);
      });

      if (mode === 'transcode') {
        // HLS via shaka-player
        this.player.configure({
          streaming: {
            retryParameters: {
              timeout: 60_000,
              maxAttempts: 5,
              baseDelay: 1000,
            },
          },
          manifest: {
            retryParameters: {
              timeout: 30_000,
              maxAttempts: 5,
              baseDelay: 1000,
            },
          },
        } as any);

        const hlsUrl = this.streamingApi.getHlsUrl(this.mediaFileId);
        console.log('[Player] HLS URL:', hlsUrl);
        await this.player.load(hlsUrl);
      } else {
        // Direct play via shaka (needed for subtitle track support)
        const streamUrl = this.streamingApi.getStreamUrl(this.mediaFileId);
        console.log('[Player] Direct URL:', streamUrl);
        await this.player.load(streamUrl, undefined, 'video/mp4');
      }

      // Load subtitles
      await this.loadSubtitles();

      // Resume position
      if (resumeTime) {
        video.currentTime = resumeTime;
      } else {
        try {
          const state = await this.streamingApi.getPlaybackState(this.mediaFileId);
          if (state && !state.completed && state.positionSeconds > 10) {
            video.currentTime = state.positionSeconds;
          }
        } catch {
          // No saved state
        }
      }

      video.play().catch(() => {
        // Autoplay may be blocked
      });

      // Save position every 10 seconds
      this.saveInterval = setInterval(() => this.savePosition(), 10_000);

      // Update stats every second
      this.statsInterval = setInterval(() => {
        if (this.statsVisible()) {
          // Trigger recompute of playerStats
          this.currentTime.set(video.currentTime);
        }
      }, 1000);
    } catch (e) {
      console.error('[Player] Init error:', e);
      this.error.set((e as Error).message);
    } finally {
      this.loading.set(false);
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', this.onKeyDown);
  }

  ngOnDestroy() {
    this.savePosition();
    this.player?.destroy();
    if (this.saveInterval) clearInterval(this.saveInterval);
    if (this.controlsTimeout) clearTimeout(this.controlsTimeout);
    if (this.statsInterval) clearInterval(this.statsInterval);
    document.removeEventListener('keydown', this.onKeyDown);
  }

  // Controls visibility
  showControls() {
    this.controlsVisible.set(true);
    if (this.controlsTimeout) clearTimeout(this.controlsTimeout);
    this.controlsTimeout = setTimeout(() => {
      if (!this.paused()) this.controlsVisible.set(false);
    }, 3000);
  }

  // Player actions
  onTogglePlay() {
    const video = this.videoEl()?.nativeElement;
    if (!video) return;
    if (video.paused) video.play();
    else video.pause();
  }

  onSeek(time: number) {
    const video = this.videoEl()?.nativeElement;
    if (!video) return;
    video.currentTime = Math.max(0, Math.min(time, this.duration() || 0));
  }

  onVolumeChange(vol: number) {
    const video = this.videoEl()?.nativeElement;
    if (!video) return;
    video.volume = vol;
    video.muted = vol === 0;
  }

  onToggleMute() {
    const video = this.videoEl()?.nativeElement;
    if (!video) return;
    video.muted = !video.muted;
  }

  onToggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen();
    }
  }

  onTogglePip() {
    const video = this.videoEl()?.nativeElement;
    if (!video) return;
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture();
    } else {
      video.requestPictureInPicture();
    }
  }

  onSpeedChange(rate: number) {
    const video = this.videoEl()?.nativeElement;
    if (!video) return;
    video.playbackRate = rate;
    this.playbackRate.set(rate);
  }

  onBack() {
    this.savePosition();
    window.history.back();
  }

  // Subtitles
  async loadSubtitles() {
    if (!this.mediaId) return;
    try {
      const options: SubtitleOption[] = [];

      const subs = await this.subtitlesApi.getForMedia(this.mediaId);
      const bitmapCodecs = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle']);
      const seen = new Set<string>(); // deduplicate by language+type

      for (const sub of subs) {
        if (sub.mediaFileId !== this.mediaFileId) continue;

        if (sub.filePath) {
          // External subtitle file (.srt, .ass)
          const key = `ext-${sub.language}-${sub.forced}-${sub.hearingImpaired}`;
          if (seen.has(key)) continue;
          seen.add(key);
          options.push({
            id: `ext-${sub.id}`,
            label: `${sub.language}${sub.hearingImpaired ? ' (HI)' : ''}${sub.forced ? ' (Forced)' : ''}`,
            url: this.streamingApi.getSubtitleUrl(this.mediaFileId, sub.id),
            language: sub.language,
          });
        } else if (sub.streamIndex != null && !bitmapCodecs.has(sub.codec ?? '')) {
          // Embedded text subtitle (from DB)
          const key = `emb-${sub.streamIndex}`;
          if (seen.has(key)) continue;
          seen.add(key);
          options.push({
            id: key,
            label: `${sub.language}${sub.hearingImpaired ? ' (HI)' : ''}${sub.forced ? ' (Forced)' : ''} [embedded]`,
            url: this.streamingApi.getEmbeddedSubtitleUrl(this.mediaFileId, sub.streamIndex!),
            language: sub.language,
          });
        }
      }

      // Also check streamInfo for embedded subs not yet in DB
      const file = this.media?.files?.find((f: any) => f.id === this.mediaFileId);
      const si = file?.streamInfo as any;
      if (si?.subtitles?.length) {
        for (const emb of si.subtitles) {
          if (bitmapCodecs.has(emb.codec)) continue;
          const key = `emb-${emb.streamIndex}`;
          if (seen.has(key)) continue;
          seen.add(key);
          options.push({
            id: key,
            label: `${emb.language}${emb.hearingImpaired ? ' (HI)' : ''}${emb.forced ? ' (Forced)' : ''} [embedded]`,
            url: this.streamingApi.getEmbeddedSubtitleUrl(this.mediaFileId, emb.streamIndex),
            language: emb.language,
          });
        }
      }

      this.availableSubtitles.set(options);
    } catch {
      // Ignore subtitle loading errors
    }
  }

  async selectSubtitle(sub: SubtitleOption | null) {
    const video = this.videoEl()?.nativeElement;
    const p = this.player as any;
    if (!video) return;

    // Disable all existing text tracks
    for (let i = 0; i < video.textTracks.length; i++) {
      video.textTracks[i].mode = 'disabled';
    }

    if (!sub) {
      if (p) p.setTextTrackVisibility(false);
      this.activeSubtitleId.set(null);
      this.subtitlePickerOpen.set(false);
      return;
    }

    // Fetch VTT and add via native TextTrack API (works in all modes)
    try {
      const res = await fetch(sub.url, { credentials: 'include' });
      const vttText = await res.text();
      const blob = new Blob([vttText], { type: 'text/vtt' });
      const blobUrl = URL.createObjectURL(blob);

      // Remove old track elements
      video.querySelectorAll('track').forEach((t) => t.remove());

      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = sub.label;
      track.srclang = sub.language;
      track.src = blobUrl;
      track.default = true;
      video.appendChild(track);
      track.track.mode = 'showing';
    } catch (e) {
      console.error('[Player] Failed to load subtitle:', e);
    }

    this.activeSubtitleId.set(sub.id);
    this.subtitlePickerOpen.set(false);
  }

  // Keyboard handler
  private onKeyDown = (e: KeyboardEvent) => {
    // Ignore if typing in an input
    if ((e.target as HTMLElement).tagName === 'INPUT') return;

    const video = this.videoEl()?.nativeElement;
    if (!video) return;

    switch (e.key) {
      case ' ':
      case 'k':
        e.preventDefault();
        this.onTogglePlay();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        this.onSeek(video.currentTime - 10);
        break;
      case 'ArrowRight':
        e.preventDefault();
        this.onSeek(video.currentTime + 10);
        break;
      case 'j':
        e.preventDefault();
        this.onSeek(video.currentTime - 30);
        break;
      case 'l':
        e.preventDefault();
        this.onSeek(video.currentTime + 30);
        break;
      case 'f':
        e.preventDefault();
        this.onToggleFullscreen();
        break;
      case 'm':
        e.preventDefault();
        this.onToggleMute();
        break;
      case 'p':
        e.preventDefault();
        this.onTogglePip();
        break;
      case 's':
        e.preventDefault();
        if (e.shiftKey) {
          this.statsVisible.set(!this.statsVisible());
        }
        break;
      case 'Escape':
        e.preventDefault();
        this.onBack();
        break;
      case '<':
        e.preventDefault();
        this.onSpeedChange(Math.max(0.25, this.playbackRate() - 0.25));
        break;
      case '>':
        e.preventDefault();
        this.onSpeedChange(Math.min(2, this.playbackRate() + 0.25));
        break;
    }
    this.showControls();
  };

  private async savePosition() {
    const video = this.videoEl()?.nativeElement;
    if (!video || !this.mediaId || !video.currentTime) return;
    try {
      const dur = isFinite(video.duration) ? video.duration : this.duration();
      await this.streamingApi.updatePlaybackState(this.mediaFileId, {
        positionSeconds: video.currentTime,
        durationSeconds: dur || 0,
        mediaId: this.mediaId,
        episodeId: this.episodeId,
      });
    } catch {
      // Ignore save errors
    }
  }

  private getStreamInfo() {
    const file = this.media?.files?.find((f: any) => f.id === this.mediaFileId);
    return file?.streamInfo as any;
  }

  private formatTime(seconds: number): string {
    if (!seconds || !isFinite(seconds)) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }
}
