import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { StreamingApiService } from './api/streaming-api.service';
import { MarkersApiService } from './api/markers-api.service';
import { TrackManagerService } from './track-manager.service';
import { inIntroRange, inOutroRange, type TimeMarker } from '../utils/player.utils';
import { RemoteService } from './remote.service';
import { buildCastAudioOptions, CastAudioOption } from './cast-player.service';
import { MediaService } from './api/media.service';
import { SubtitlesApiService } from './api/subtitles-api.service';
import { buildSubtitleTracks } from '../utils/subtitle-tracks';
import { formatSubtitleParts, formatSubtitleLabel, SpriteMetadata } from '../utils/player.utils';
import { PlaybackOption, PlaybackTarget } from './playback-target';

/** Whether `app-cast-overlay` is showing the remote-target control card.
 *  The remote picker (`shared/remote-picker`) flips it on after picking a
 *  target; this adapter's `disconnect` and `expanded` are its only other users. */
export const remoteOverlayOpen = signal(false);

/**
 * Drives the cast-overlay UI from a remote target instead of a Chromecast
 * session. Track lists come from the played file's streamInfo, fetched here
 * once the target reports what it's playing.
 */
@Injectable({ providedIn: 'root' })
export class RemotePlaybackTarget implements PlaybackTarget {
  private readonly remote = inject(RemoteService);
  private readonly streamingApi = inject(StreamingApiService);
  private readonly markersApi = inject(MarkersApiService);
  private readonly trackManager = inject(TrackManagerService);
  private readonly mediaService = inject(MediaService);
  private readonly subtitlesApi = inject(SubtitlesApiService);
  private readonly translate = inject(TranslateService);

  readonly currentTime = this.remote.interpolatedPosition;
  readonly duration = computed(() => this.remote.targetState()?.durationSeconds ?? 0);
  readonly isConnected = this.remote.isRemoting;
  /** A selected target is present even with nothing playing: releasing it is
   *  an explicit action, not a side effect of stopping the media. */
  readonly hasMedia = computed(() => this.remote.isRemoting());
  /** Only a real pause, never buffering: a target filling its buffer is on its
   *  way to playing, and showing a play icon there invites a press that would
   *  stop it. */
  readonly isPaused = computed(() => this.remote.targetState()?.state === 'paused');
  /** Also while the target rebuilds its stream for a quality change: the card
   *  keeps its poster and position and simply reads as loading. */
  readonly buffering = computed(
    () => this.remote.targetState()?.state === 'buffering' || this.remote.restarting(),
  );
  readonly volume = computed(() => this.remote.targetState()?.volume ?? 1);
  readonly muted = computed(() => this.remote.targetState()?.muted ?? false);
  readonly mediaTitle = computed(() => this.remote.targetState()?.mediaTitle ?? '');
  readonly fanartUrl = computed(
    () =>
      this.remote.targetState()?.posterUrl ??
      this.remote.selectedTarget()?.nowPlaying?.posterUrl ??
      null,
  );
  /** RemoteNowPlaying carries no episode label. */
  readonly episodeTitle = computed(() => this.remote.targetState()?.episodeLabel ?? '');
  readonly activeQualityId = computed(() => this.remote.targetState()?.quality ?? 'auto');
  readonly activeAudioTrackId = computed(() => {
    const idx = this.remote.targetState()?.audioTrackIndex;
    return idx != null ? `audio-${idx}` : null;
  });
  readonly activeSubtitleId = computed(() => this.remote.targetState()?.subtitleId ?? null);
  readonly spriteUrl = signal<string | null>(null);
  readonly spriteMetadata = signal<SpriteMetadata | null>(null);
  /** The target's own rungs, so a pick names an id it accepts. There is one eco
   *  rung per height, so without the second line the list repeats a label. */
  readonly availableQualities = computed<PlaybackOption[]>(() =>
    (this.remote.targetState()?.qualities ?? []).map((q) => ({
      id: q.id,
      label: q.label,
      sub: q.lowBandwidth ? this.translate.instant('player.low_bandwidth') : undefined,
    })),
  );
  readonly expanded = remoteOverlayOpen;

  private readonly audioOptions = signal<CastAudioOption[]>([]);
  private readonly subtitleOptions = signal<PlaybackOption[]>([]);
  readonly availableAudioTracks = this.audioOptions.asReadonly();
  readonly availableSubtitles = this.subtitleOptions.asReadonly();

  private tracksLoadedForKey: string | null = null;

  constructor() {
    effect(() => {
      this.remote.selectedTargetId();
      untracked(() => {
        this.tracksLoadedForKey = null;
        this.audioOptions.set([]);
        this.subtitleOptions.set([]);
      });
    });

    effect(() => {
      const s = this.remote.targetState();
      if (!s?.mediaId || !s.mediaFileId) return;
      const key = `${s.mediaId}:${s.mediaFileId}`;
      if (key === this.tracksLoadedForKey) return;
      this.tracksLoadedForKey = key;
      untracked(() => void this.loadTracks(s.mediaId!, s.mediaFileId));
    });
  }

  seek(time: number): void {
    const targetId = this.remote.selectedTargetId();
    if (!targetId) {
      console.warn('[remote-playback-target] seek with no selected target');
      return;
    }
    this.remote.sendCoalesced(targetId, { action: 'seek', positionSeconds: time });
  }

  setVolume(level: number): void {
    const targetId = this.remote.selectedTargetId();
    if (!targetId) {
      console.warn('[remote-playback-target] setVolume with no selected target');
      return;
    }
    this.remote.pinVolume(level);
    this.remote.sendCoalesced(targetId, { action: 'volume', level });
  }

  togglePlayPause(): void {
    const targetId = this.remote.selectedTargetId();
    const s = this.remote.targetState();
    if (!targetId || !s) {
      console.warn('[remote-playback-target] togglePlayPause with no target/state');
      return;
    }
    void this.remote.send(targetId, { action: s.state === 'playing' ? 'pause' : 'play' });
  }

  toggleMute(): void {
    const targetId = this.remote.selectedTargetId();
    const s = this.remote.targetState();
    if (!targetId || !s) {
      console.warn('[remote-playback-target] toggleMute with no target/state');
      return;
    }
    void this.remote.send(targetId, { action: 'mute', muted: !(s.muted ?? false) });
  }

  selectAudio(track: PlaybackOption | null): void {
    const targetId = this.remote.selectedTargetId();
    if (!targetId || !track) {
      console.warn('[remote-playback-target] selectAudio with no target/track');
      return;
    }
    void this.remote.send(targetId, { action: 'audio', trackId: track.id });
  }

  selectSubtitle(sub: PlaybackOption | null): void {
    const targetId = this.remote.selectedTargetId();
    if (!targetId) {
      console.warn('[remote-playback-target] selectSubtitle with no selected target');
      return;
    }
    void this.remote.send(targetId, { action: 'subtitle', subtitleId: sub?.id ?? null });
  }

  selectQuality(quality: PlaybackOption): void {
    const targetId = this.remote.selectedTargetId();
    if (!targetId) {
      console.warn('[remote-playback-target] selectQuality with no selected target');
      return;
    }
    void this.remote.send(targetId, { action: 'quality', qualityId: quality.id });
  }

  private readonly introMarker = signal<TimeMarker | null>(null);
  private readonly outroMarker = signal<TimeMarker | null>(null);

  /** Same range tests the local player applies, against the interpolated
   *  position, so the offer appears and retracts at the same instants. */
  readonly canSetVolume = computed(() => this.remote.targetState()?.supportsVolume ?? true);

  readonly skipCue = computed<{ labelKey: string } | null>(() => {
    const at = this.remote.interpolatedPosition();
    if (inIntroRange(this.introMarker(), at)) return { labelKey: 'player.skip_intro' };
    if (inOutroRange(this.outroMarker(), at)) return { labelKey: 'player.next_episode' };
    return null;
  });

  readonly isStarting = computed(
    () =>
      this.remote.targetState() === null &&
      (this.remote.pendingAction() === 'load' || this.remote.awaitingFirstReport()),
  );
  readonly isIdle = computed(
    () => this.remote.targetState() === null && !this.isStarting(),
  );
  readonly targetOffline = this.remote.targetOffline.asReadonly();
  /** Its own play button is refused for the same reason, so the card has to say
   *  where the gesture must happen instead of implying it can act. */
  readonly autoplayBlocked = computed(
    () => this.remote.targetState()?.autoplayBlocked ?? false,
  );
  readonly canStopControlling = true;

  skip(): void {
    const targetId = this.remote.selectedTargetId();
    const at = this.remote.interpolatedPosition();
    if (!targetId) {
      console.warn('[remote-playback-target] skip with no selected target');
      return;
    }
    const intro = this.introMarker();
    if (inIntroRange(intro, at)) {
      void this.remote.send(targetId, { action: 'seek', positionSeconds: intro!.endSeconds });
      return;
    }
    if (inOutroRange(this.outroMarker(), at)) {
      void this.remote.send(targetId, { action: 'next' });
      return;
    }
    console.warn('[remote-playback-target] skip with no cue active');
  }

  stopPlayback(): void {
    const targetId = this.remote.selectedTargetId();
    if (!targetId) {
      console.warn('[remote] stop requested with no selected target');
      return;
    }
    // Keep the target selected: stopping the media is not giving the device
    // back. The card closes because there is nothing left in it to act on, and
    // the top-bar chip reopens it.
    void this.remote.send(targetId, { action: 'stop' });
    remoteOverlayOpen.set(false);
  }

  disconnect(): void {
    this.remote.selectTarget(null);
    remoteOverlayOpen.set(false);
  }

  /** Reuse the very builder the target runs, rather than assembling a second
   *  list here: a different set of options produced different rows, so the
   *  controller's selection named a track the target did not have. */
  private async loadTracks(mediaId: number, mediaFileId: number): Promise<void> {
    try {
      const media = await this.mediaService.getOne(mediaId).catch(() => null);
      const file = (media?.files ?? []).find((f: { id: number }) => f.id === mediaFileId);
      this.audioOptions.set(buildCastAudioOptions(file?.streamInfo?.audio, this.translate));
      void this.loadSprites(mediaFileId);
      void this.loadMarkers(this.remote.targetState()?.episodeId ?? null);

      const subs = await this.trackManager.loadSubtitles(
        mediaId,
        mediaFileId,
        this.streamingApi,
        media,
      );
      this.subtitleOptions.set(
        subs.map((o) => ({
          id: o.id,
          label: o.label,
          head: o.menuHead,
          sub: o.menuSub,
        })),
      );
    } catch (err) {
      console.warn('[remote-playback-target] failed to load tracks', mediaId, mediaFileId, err);
    }
  }

  /** Markers are per-episode, so a film simply has no cue. */
  private async loadMarkers(episodeId: number | null): Promise<void> {
    this.introMarker.set(null);
    this.outroMarker.set(null);
    if (!episodeId) return;
    try {
      const markers = await this.markersApi.listForEpisode(episodeId);
      this.introMarker.set(markers.find((m) => m.type === 'intro') ?? null);
      this.outroMarker.set(markers.find((m) => m.type === 'outro') ?? null);
    } catch (err) {
      console.warn('[remote-playback-target] failed to load markers', episodeId, err);
    }
  }

  /** Seek previews belong to the file, not to whoever plays it, so the same
   *  sprite sheet the local player and the Cast sender use serves here too. */
  private async loadSprites(mediaFileId: number): Promise<void> {
    this.spriteUrl.set(null);
    this.spriteMetadata.set(null);
    try {
      const res = await fetch(this.streamingApi.getThumbnailMetadataUrl(mediaFileId));
      if (!res.ok) {
        console.warn('[remote-playback-target] no sprite metadata', mediaFileId, res.status);
        return;
      }
      this.spriteMetadata.set((await res.json()) as SpriteMetadata);
      this.spriteUrl.set(this.streamingApi.getThumbnailSpriteUrl(mediaFileId));
    } catch (err) {
      console.warn('[remote-playback-target] failed to load sprites', mediaFileId, err);
    }
  }
}
