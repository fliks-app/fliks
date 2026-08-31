import { Injectable, computed, inject } from '@angular/core';
import { CastService } from './cast.service';
import { CastPlayerService, CastSubtitleOption } from './cast-player.service';
import { parseAudioIndex } from '../utils/player.utils';
import { PlaybackOption, PlaybackTarget } from './playback-target';

/**
 * Pure pass-through to CastService + CastPlayerService: the Chromecast
 * behaviour behind this facade is byte-for-byte what it was before.
 */
@Injectable({ providedIn: 'root' })
export class CastPlaybackTarget implements PlaybackTarget {
  private readonly cast = inject(CastService);
  private readonly cp = inject(CastPlayerService);

  readonly buffering = this.cast.buffering;
  readonly currentTime = this.cast.currentTime;
  readonly duration = this.cast.duration;
  readonly isConnected = this.cast.isConnected;
  readonly isPaused = this.cast.isPaused;
  readonly muted = this.cast.muted;
  readonly volume = this.cast.volume;
  readonly hasMedia = this.cp.hasMedia;
  readonly mediaTitle = this.cp.mediaTitle;
  readonly episodeTitle = this.cp.episodeTitle;
  readonly fanartUrl = this.cp.fanartUrl;
  readonly spriteUrl = this.cp.spriteUrl;
  readonly spriteMetadata = this.cp.spriteMetadata;
  readonly availableSubtitles = this.cp.availableSubtitles;
  readonly availableAudioTracks = this.cp.availableAudioTracks;
  readonly availableQualities = this.cp.availableQualities;
  readonly activeSubtitleId = this.cp.activeSubtitleId;
  readonly activeAudioTrackId = this.cp.activeAudioTrackId;
  readonly activeQualityId = this.cp.activeQualityId;
  readonly expanded = this.cp.expanded;

  seek(time: number): void {
    this.cast.seek(time);
  }

  setVolume(level: number): void {
    this.cast.setVolume(level);
  }

  toggleMute(): void {
    this.cast.toggleMute();
  }

  togglePlayPause(): void {
    this.cast.togglePlayPause();
  }

  selectSubtitle(sub: PlaybackOption | null): void {
    // Built by us via cp.availableSubtitles(), so the extra Cast fields are always present.
    const s = sub as CastSubtitleOption | null;
    if (!s) {
      this.cp.activeSubtitleId.set(null);
      this.cast.setActiveSubtitle(0);
      this.cp.changeBurnIn(null);
      this.cp.saveSubtitleSelection(null);
      return;
    }
    this.cp.activeSubtitleId.set(s.id);
    this.cp.saveSubtitleSelection(s.language, s.forced);
    if (s.burnIn) {
      this.cp.changeBurnIn(s.castTrackId ?? 0);
    } else if (s.castTrackId) {
      this.cast.setActiveSubtitle(s.castTrackId);
    }
  }

  selectAudio(track: PlaybackOption | null): void {
    if (!track) return;
    this.cp.activeAudioTrackId.set(track.id);
    this.cp.changeAudio(parseAudioIndex(track.id));
  }

  selectQuality(quality: PlaybackOption): void {
    if (quality.id === this.cp.activeQualityId()) return;
    this.cp.changeQuality(quality.id);
  }

  readonly isStarting = computed(() => false);
  readonly isIdle = computed(() => false);
  readonly canStopControlling = false;

  stopPlayback(): void {
    this.disconnect();
  }

  disconnect(): void {
    this.cast.stop();
    this.cp.clear();
    this.cp.expanded.set(false);
  }
}
