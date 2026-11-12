import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { MusicApiService, alignTrackRows } from '../api/music-api.service';
import { NowPlayingMetadataService } from '../playback/now-playing-metadata.service';
import { RemotePlaybackTarget } from '../remote-playback-target';
import { RemoteService, type RemoteAction, type RemoteCommandInput } from '../remote.service';
import { SessionSyncService } from '../session-sync.service';
import type { AudioRequest } from './audio-player.service';
import { FullPlayerState } from './full-player-state';
import type { AudioOutput } from './audio-output';
import type { MusicTrackRequest, Repeat } from './music-queue';

const NEXT_REPEAT: Record<Repeat, Repeat> = { off: 'all', all: 'one', one: 'off' };

/** The audio session of another device, driven by commands sent to it: the full player's view of it. */
@Injectable({ providedIn: 'root' })
export class RemoteAudioOutput implements AudioOutput {
  private readonly sync = inject(SessionSyncService);
  private readonly remote = inject(RemoteService);
  private readonly target = inject(RemotePlaybackTarget);
  private readonly music = inject(MusicApiService);
  private readonly metadata = inject(NowPlayingMetadataService);
  private readonly fullPlayer = inject(FullPlayerState);

  private readonly session = this.sync.session;
  private readonly wire = computed(() => this.session()?.queue ?? null);
  /** Each row keeps its place in the wire queue, which a queue pick names. */
  private readonly rows = signal<{ row: MusicTrackRequest; wireIndex: number }[]>([]);
  private readonly idsKey = computed(() => (this.wire()?.itemIds ?? []).join(','));
  /** The owner reports the file the session names; a report of another track never drives the view. */
  private readonly live = computed(() => this.sync.liveReport() !== null);
  /** Commands reach a playing owner whether or not its report has arrived; a parked session has no owner to send to. */
  readonly controllable = computed(() => !this.sync.parked());

  /** Whether the observed device applies `action`; a control for one it refuses stays disabled. */
  supports(action: RemoteAction): boolean {
    return this.remote.observedCan(action);
  }

  readonly expanded = computed(() => this.fullPlayer.open() && this.fullPlayer.remote());
  readonly musicMode = signal(true).asReadonly();
  readonly rate = computed(() => (this.live() ? (this.remote.targetState()?.playbackRate ?? 1) : 1));
  readonly queue = computed(() => this.rows().map((r) => r.row));
  readonly queueIndex = computed(() => {
    const index = this.wire()?.index;
    const i = this.rows().findIndex((r) => r.wireIndex === index);
    return i >= 0 ? i : this.rows().findIndex((r) => r.row.itemId === this.session()?.item.id);
  });
  readonly shuffle = computed(() => this.wire()?.shuffle ?? false);
  readonly repeat = computed<Repeat>(() => this.wire()?.repeat ?? 'off');
  readonly playing = computed(() => (this.live() ? !this.target.uiPaused() : (this.session()?.playing ?? false) && this.controllable()));
  /** While this device claims the session, the old owner's pause on its way out is not shown. */
  readonly uiPlaying = computed(() => (this.sync.claimPending() ? (this.session()?.playing ?? false) : this.playing()));
  readonly position = computed(() => {
    const s = this.session();
    return s ? Math.min(this.sync.positionNow(s), s.durationSeconds ?? Infinity) : 0;
  });
  readonly duration = computed(() => {
    const s = this.session();
    return s ? this.sync.durationNow(s) : 0;
  });
  readonly track = computed<AudioRequest | null>(() => {
    const s = this.session();
    if (!s) return null;
    const row = this.rows().find((r) => r.row.itemId === s.item.id)?.row;
    // An album session's `subtitle` is the track title, `title` the album.
    const album = s.item.kind === 'album';
    return {
      mediaId: s.item.mediaId,
      itemId: s.item.id,
      title: row?.title ?? (album ? s.item.subtitle : s.item.title) ?? '',
      artist: row?.artists ?? (album ? undefined : (s.item.subtitle ?? undefined)),
      album: row?.albumTitle,
      coverUrl: row?.coverUrl ?? s.item.posterUrl,
    };
  }, { equal: sameTrack });

  constructor() {
    effect((onCleanup) => {
      const ids = this.idsKey() ? this.idsKey().split(',').map(Number) : [];
      let stale = false;
      onCleanup(() => (stale = true));
      void this.music.trackRequests(ids).then(
        (r) => {
          if (stale) return;
          this.metadata.primeTracks(r);
          this.rows.set(alignTrackRows(ids, r));
        },
        () => !stale && this.rows.set([]),
      );
    });
    // The view ends with the observation; a takeover by this device is handed over by the player component.
    effect(() => {
      if (this.expanded() && !this.session()) this.fullPlayer.hide();
    });
  }

  expand(): void {
    this.fullPlayer.show(true);
  }

  collapse(): void {
    this.fullPlayer.hide();
  }

  /** Stopping the other device is not offered here: closing leaves the view. */
  close(): void {
    this.collapse();
  }

  toggle(): void {
    this.send({ action: this.playing() ? 'pause' : 'play' });
  }

  seek(position: number): void {
    this.target.seek(position);
  }

  next(): void {
    this.send({ action: 'next' });
  }

  previous(): void {
    this.send({ action: 'prev' });
  }

  setShuffle(on: boolean): void {
    this.send({ action: 'shuffle', shuffle: on });
  }

  cycleRepeat(): void {
    this.send({ action: 'repeat', repeat: NEXT_REPEAT[this.repeat()] });
  }

  playQueueAt(index: number): void {
    const wire = this.wire();
    const row = this.rows()[index];
    if (wire && row) this.send({ action: 'queue', queue: { itemIds: wire.itemIds, index: row.wireIndex } });
  }

  private send(input: RemoteCommandInput): void {
    const id = this.remote.observedTargetId();
    if (id) void this.remote.send(id, input);
  }
}

/** Every session report rebuilds the track; only a real change may re-run what follows it. */
function sameTrack(a: AudioRequest | null, b: AudioRequest | null): boolean {
  return a === b || (!!a && !!b && a.itemId === b.itemId && a.mediaId === b.mediaId && a.title === b.title
    && a.artist === b.artist && a.album === b.album && a.coverUrl === b.coverUrl);
}
