import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { StreamingApiService } from './api/streaming-api.service';
import { RemoteService } from './remote.service';
import { buildCastAudioOptions, CastAudioOption } from './cast-player.service';
import { MediaService } from './api/media.service';
import { SubtitlesApiService } from './api/subtitles-api.service';
import { buildSubtitleTracks } from '../utils/subtitle-tracks';
import { formatSubtitleLabel, SpriteMetadata } from '../utils/player.utils';
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
  private readonly mediaService = inject(MediaService);
  private readonly subtitlesApi = inject(SubtitlesApiService);
  private readonly translate = inject(TranslateService);

  readonly currentTime = this.remote.interpolatedPosition;
  readonly duration = computed(() => this.remote.targetState()?.durationSeconds ?? 0);
  readonly isConnected = this.remote.isRemoting;
  /** A selected target is present even with nothing playing: releasing it is
   *  an explicit action, not a side effect of stopping the media. */
  readonly hasMedia = computed(() => this.remote.isRemoting());
  readonly isPaused = computed(() => this.remote.targetState()?.state !== 'playing');
  readonly buffering = computed(() => this.remote.targetState()?.state === 'buffering');
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
  readonly episodeTitle = signal('');
  readonly activeQualityId = computed(() => this.remote.targetState()?.quality ?? 'auto');
  readonly activeAudioTrackId = computed(() => {
    const idx = this.remote.targetState()?.audioTrackIndex;
    return idx != null ? `audio-${idx}` : null;
  });
  // ponytail: wire has no active-subtitle report; never invent a value here.
  readonly activeSubtitleId = signal<string | null>(null);
  readonly spriteUrl = signal<string | null>(null);
  readonly spriteMetadata = signal<SpriteMetadata | null>(null);
  /** No quality control on a remote target: an empty list hides the picker. */
  readonly availableQualities = signal<PlaybackOption[]>([]);
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

  selectQuality(_quality: PlaybackOption): void {
    console.warn('[remote-playback-target] quality cannot be changed on a remote target');
  }

  readonly isStarting = computed(
    () => this.remote.targetState() === null && this.remote.pendingAction() === 'load',
  );
  readonly isIdle = computed(
    () => this.remote.targetState() === null && !this.isStarting(),
  );
  readonly canStopControlling = true;

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

  /** Fetch the file's tracks independent of which device plays it: the same
   *  streamInfo/subtitle rows the Cast picker and the local player use. */
  private async loadTracks(mediaId: number, mediaFileId: number): Promise<void> {
    try {
      const [media, subs] = await Promise.all([
        this.mediaService.getOne(mediaId).catch(() => null),
        this.subtitlesApi.getForMedia(mediaId).catch(() => [] as any[]),
      ]);
      const file = (media?.files ?? []).find((f: any) => f.id === mediaFileId);
      this.audioOptions.set(buildCastAudioOptions(file?.streamInfo?.audio, this.translate));
      void this.loadSprites(mediaFileId);
      const tracks = buildSubtitleTracks(subs, mediaFileId, { hideBurnIn: false });
      this.subtitleOptions.set(
        tracks.map((t, i) => ({
          id: t.key,
          label: formatSubtitleLabel(t, this.translate, i + 1),
        })),
      );
    } catch (err) {
      console.warn('[remote-playback-target] failed to load tracks', mediaId, mediaFileId, err);
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
