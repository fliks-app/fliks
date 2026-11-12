import { Injectable, computed, effect, inject, linkedSignal, signal } from '@angular/core';
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

/** How long a skip sent from here shows before the owner's report, should that report never come. */
const PENDING_MS = 5000;

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
  /** No device holds the session: play takes it here, nothing else is sent. */
  readonly parked = this.sync.parked;

  /** Whether the observed device applies `action`; a control for one it refuses stays disabled. */
  supports(action: RemoteAction): boolean {
    return this.remote.observedCan(action);
  }

  readonly expanded = computed(() => this.fullPlayer.open() && this.fullPlayer.remote());
  readonly musicMode = signal(true).asReadonly();
  readonly rate = computed(() => (this.live() ? (this.remote.targetState()?.playbackRate ?? 1) : 1));
  readonly queue = computed(() => this.rows().map((r) => r.row));
  private readonly reportedIndex = computed(() => {
    const index = this.wire()?.index;
    const i = this.rows().findIndex((r) => r.wireIndex === index);
    return i >= 0 ? i : this.rows().findIndex((r) => r.row.itemId === this.session()?.item.id);
  });
  /** The row a skip sent from here moved to, shown until the owner reports another track or index. */
  private readonly pending = linkedSignal<string, number | null>({
    source: () => `${this.wire()?.index}|${this.session()?.item.id}`,
    computation: () => null,
  });
  private pendingTimer: ReturnType<typeof setTimeout> | undefined;
  readonly queueIndex = computed(() => this.pending() ?? this.reportedIndex());
  readonly shuffle = computed(() => this.wire()?.shuffle ?? false);
  readonly repeat = computed<Repeat>(() => this.wire()?.repeat ?? 'off');
  readonly playing = computed(() => (this.live() ? !this.target.uiPaused() : (this.session()?.playing ?? false) && this.controllable()));
  /** While this device claims the session, the old owner's pause on its way out is not shown. */
  readonly uiPlaying = computed(() => (this.sync.claimPending() ? (this.session()?.playing ?? false) : this.playing()));
  readonly position = computed(() => {
    if (this.pending() !== null) return 0;
    const s = this.session();
    return s ? Math.min(this.sync.positionNow(s), s.durationSeconds ?? Infinity) : 0;
  });
  readonly duration = computed(() => {
    const pending = this.pending();
    if (pending !== null) return this.rows()[pending]?.row.durationSeconds ?? 0;
    const s = this.session();
    return s ? this.sync.durationNow(s) : 0;
  });
  readonly track = computed<AudioRequest | null>(() => {
    const s = this.session();
    if (!s) return null;
    const pending = this.pending();
    const next = pending === null ? null : this.rows()[pending]?.row;
    if (next) {
      return { mediaId: next.mediaId, itemId: next.itemId, title: next.title, artist: next.artists, album: next.albumTitle, coverUrl: next.coverUrl };
    }
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

  readonly volume = this.target.volume;
  readonly muted = this.target.muted;
  readonly canSetVolume = this.target.canSetVolume;

  setVolume(level: number): void {
    this.target.setVolume(level);
  }

  toggleMute(): void {
    this.target.toggleMute();
  }

  /** `track` already follows a skip sent from here. */
  readonly uiTrack = this.track;

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
    if (this.parked()) return void this.sync.playHere();
    this.send({ action: this.playing() ? 'pause' : 'play' });
  }

  seek(position: number): void {
    this.target.seek(position);
  }

  next(): void {
    this.skip(1, { action: 'next' });
  }

  previous(): void {
    this.skip(-1, { action: 'prev' });
  }

  neighbour(step: 1 | -1): MusicTrackRequest | null {
    return this.queue()[this.neighbourIndex(step)] ?? null;
  }

  private neighbourIndex(step: 1 | -1): number {
    const n = this.queue().length;
    const i = this.queueIndex();
    const j = i + step;
    if (i < 0 || !n) return -1;
    return j >= 0 && j < n ? j : this.repeat() === 'all' ? (j + n) % n : -1;
  }

  private skip(step: 1 | -1, input: RemoteCommandInput): void {
    const i = this.neighbourIndex(step);
    this.send(input);
    if (i < 0) return;
    this.pending.set(i);
    clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => this.pending.set(null), PENDING_MS);
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
