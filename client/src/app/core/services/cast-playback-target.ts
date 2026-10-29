import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { CastService } from './cast.service';
import { CastPlayerService } from './cast-player.service';
import { parseAudioIndex } from '../utils/player.utils';
import { TranslateService } from '@ngx-translate/core';
import { PlaybackOption, PlaybackOutput, PlaybackSync } from './playback/playback-output';
import { PlaybackSession } from './playback/playback-session';
import { PartyService } from './party/party.service';
import { CAST_DRIFT_IGNORE_S, CAST_SEEK_COOLDOWN_MS } from './party/party-drift';
import { MediaService } from './api/media.service';
import { PlayerSettingsService } from './player-settings.service';
import { QueueItem } from './playback-queue.service';
import { resolveNextEpisodeItem } from '../../shared/utils/media-play.util';

/** The Chromecast receiver as a playback output: a pass-through facade to CastService + CastPlayerService. */
@Injectable({ providedIn: 'root' })
export class CastPlaybackTarget implements PlaybackOutput {
  private readonly cast = inject(CastService);
  private readonly cp = inject(CastPlayerService);
  private readonly translate = inject(TranslateService);
  private readonly mediaService = inject(MediaService);
  private readonly playerSettings = inject(PlayerSettingsService);
  private readonly session = inject(PlaybackSession);
  private readonly party = inject(PartyService);

  readonly buffering = this.cast.buffering;
  readonly duration = this.cast.duration;
  readonly isConnected = this.cast.isConnected;
  readonly paused = this.cast.isPaused;
  readonly uiPaused = this.cast.isPaused;
  readonly ended = this.cast.ended;
  readonly seekLocked = computed(() => false);
  readonly position = this.cast.currentTime;
  /** Not while a LOAD is in flight: a party applied to the old media would be undone when the new one starts. */
  readonly ready = computed(
    () => this.cast.isConnected() && this.cp.hasMedia() && !this.cp.reloading() && this.cast.duration() > 0,
  );
  readonly item = computed(() => ({ mediaId: this.cp.mediaId(), episodeId: this.cp.episodeId() }));
  readonly sync: PlaybackSync = { slackS: CAST_DRIFT_IGNORE_S, drift: { ignoreS: CAST_DRIFT_IGNORE_S, cooldownMs: CAST_SEEK_COOLDOWN_MS } };
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
  /** Same second line as a remote target: one eco rung per height would
   *  otherwise show the same label twice. */
  readonly availableQualities = computed<PlaybackOption[]>(() =>
    this.cp.availableQualities().map((q) => ({
      id: q.id,
      label: q.label,
      sub: q.lowBandwidth ? this.translate.instant('player.low_bandwidth') : undefined,
    })),
  );
  readonly activeSubtitleId = this.cp.activeSubtitleId;
  readonly activeAudioTrackId = this.cp.activeAudioTrackId;
  readonly activeQualityId = this.cp.activeQualityId;

  seek(time: number): void {
    this.cast.seek(time);
  }

  play(): void {
    this.cast.play();
  }

  pause(): Promise<void> {
    this.cast.pause();
    return Promise.resolve();
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
    void this.cp.selectSubtitle(sub?.id ?? null);
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

  async selectAudioById(trackId: string): Promise<void> {
    const idx = parseAudioIndex(trackId);
    if (Number.isNaN(idx)) {
      console.warn('[remote] cast cannot resolve audio track', trackId);
      return;
    }
    await this.cp.changeAudio(idx);
  }

  async selectSubtitleById(id: string | null): Promise<void> {
    await this.cp.selectSubtitle(id);
  }

  selectQualityById(id: string): Promise<void> {
    return this.cp.changeQuality(id);
  }

  // Marker-driven skipping is not wired into the Cast sender today.
  readonly canSetVolume = computed(() => true);
  readonly skipCue = computed<{ labelKey: string } | null>(() => null);
  readonly isStarting = computed(() => false);
  readonly isIdle = computed(() => false);
  readonly targetOffline = computed(() => false);
  /** A receiver is started by the sender's own gesture, so this cannot arise. */
  readonly autoplayBlocked = computed(() => false);

  skip(): void {
    console.warn('[cast-playback-target] no skip cue on a Cast session');
  }

  /** Resolved ahead of the press: offering a next episode that turns out not to
   *  exist would leave a button that does nothing on the last one. */
  private readonly nextItem = signal<QueueItem | null>(null);
  readonly canPlayNext = computed(() => this.nextItem() !== null);

  private readonly nextItemEffect = effect(() => {
    const mediaId = this.cp.mediaId();
    const episodeId = this.cp.episodeId();
    untracked(() => {
      this.nextItem.set(null);
      if (!mediaId || !episodeId) return;
      void this.mediaService
        .getOne(mediaId)
        .then((m) => {
          // The session may have moved on while the fetch was in flight.
          if (this.cp.episodeId() !== episodeId) return;
          this.nextItem.set(resolveNextEpisodeItem(m, episodeId));
        })
        .catch((err) => console.warn('[cast-playback-target] next episode lookup failed', err));
    });
  });

  /** Solo auto-next; a party host's end goes through the party's `ended` intent. */
  private readonly endedEffect = effect(() => {
    if (!this.cast.ended()) return;
    untracked(() => {
      if (this.party.drives() || !this.playerSettings.settings().autoPlayNext || !this.canPlayNext()) return;
      this.playNext();
    });
  });

  playNext(): void {
    const next = this.nextItem();
    if (!next?.mediaFileId) {
      console.warn('[cast-playback-target] playNext with nothing queued');
      return;
    }
    void this.session.play(
      {
        fileId: next.mediaFileId,
        mediaId: next.mediaId,
        episodeId: next.episodeId,
        title: next.title,
        episodeTitle: next.episodeTitle,
        fanartUrl: next.fanartUrl,
      },
      { fromStart: true, expand: false },
    );
  }

  /** Stop the media but stay on the device: the session outlives it, and the
   *  top-bar chip is how you come back to it. */
  stopPlayback(): void {
    // The receiver must keep a stream for the party to drive: stopping leaves the cast instead.
    if (this.party.drives()) return this.disconnect();
    this.cast.stop();
    this.cp.clear();
  }

  /** Leave the device. Ends the Cast session, which stops the receiver with it. */
  disconnect(): void {
    this.cast.disconnect();
    this.cp.clear();
  }
}
