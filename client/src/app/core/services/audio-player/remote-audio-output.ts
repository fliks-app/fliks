import { Injectable, computed, effect, inject, linkedSignal, signal, untracked } from '@angular/core';
import { MusicApiService, alignTrackRows } from '../api/music-api.service';
import { NowPlayingMetadataService } from '../playback/now-playing-metadata.service';
import { PlaybackSession } from '../playback/playback-session';
import { RemotePlaybackTarget } from '../remote-playback-target';
import { RemoteService, type RemoteAction, type RemoteCommandInput } from '../remote.service';
import { SessionSyncService } from '../session-sync.service';
import type { AudioRequest } from './audio-player.service';
import { FullPlayerState } from '../playback/full-player-state';
import type { AudioOutput } from './audio-output';
import type { MusicTrackRequest, Repeat } from './music-queue';
import type { StemMode } from './stem-mix';

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
  private readonly playback = inject(PlaybackSession);

  /** A selected device plays outside the account session: the view reads that device's own report instead. */
  readonly selected = this.remote.isRemoting;
  /** The account session, while the view follows its owner. */
  private readonly session = computed(() => (this.selected() ? null : this.sync.session()));
  /** The queue of the account session, or the one a selected device reports itself. */
  private readonly wire = computed(() => (this.selected() ? this.remote.targetQueue() : (this.session()?.queue ?? null)));
  /** Each row keeps its place in the wire queue, which a queue pick names. */
  private readonly rows = signal<{ row: MusicTrackRequest; wireIndex: number }[]>([]);
  private readonly idsKey = computed(() => (this.wire()?.itemIds ?? []).join(','));
  /** The device reports what the view shows: anything a selected one plays, the file the session names for its owner. */
  private readonly live = computed(() => (this.selected() ? this.remote.targetState() !== null : this.sync.liveReport() !== null));
  /** Commands reach a playing device whether or not its report has arrived; a parked session has no owner to send to. */
  readonly controllable = computed(() => !this.parked());
  /** No device holds the session: play takes it here, nothing else is sent. */
  readonly parked = computed(() => !this.selected() && this.sync.parked());

  /** Whether the observed device applies `action`; a control for one it refuses stays disabled. */
  supports(action: RemoteAction): boolean {
    return this.remote.observedCan(action);
  }

  readonly expanded = computed(() => this.fullPlayer.open() === 'audio' && this.fullPlayer.remote());
  readonly musicMode = signal(true).asReadonly();
  readonly rate = computed(() => (this.live() ? (this.remote.targetState()?.playbackRate ?? 1) : 1));
  readonly queue = computed(() => this.rows().map((r) => r.row));
  /** The item played: the session's, or the selected device's, kept through the gap between two of its tracks. */
  private readonly itemId = computed(() => (this.selected() ? this.selectedTrack()?.itemId : this.session()?.item.id));
  private readonly reportedIndex = computed(() => {
    const index = this.wire()?.index;
    const i = this.rows().findIndex((r) => r.wireIndex === index);
    return i >= 0 ? i : this.rows().findIndex((r) => r.row.itemId === this.itemId());
  });
  /** The row a skip sent from here moved to, shown until the owner reports another track or index. */
  private readonly pending = linkedSignal<string, number | null>({
    source: () => `${this.wire()?.index}|${this.itemId()}`,
    computation: () => null,
  });
  /** The track of that row, shown ahead of the report. */
  private readonly pendingTrack = computed<AudioRequest | null>(() => {
    const pending = this.pending();
    const next = pending === null ? null : this.rows()[pending]?.row;
    return next ? { mediaId: next.mediaId, itemId: next.itemId, title: next.title, artist: next.artists, album: next.albumTitle, coverUrl: next.coverUrl } : null;
  });
  private pendingTimer: ReturnType<typeof setTimeout> | undefined;
  readonly queueIndex = computed(() => this.pending() ?? this.reportedIndex());
  readonly shuffle = computed(() => this.wire()?.shuffle ?? false);
  readonly repeat = computed<Repeat>(() => this.wire()?.repeat ?? 'off');
  readonly buffering = computed(() => this.live() && this.target.buffering());
  readonly playing = computed(() => (this.live() ? !this.target.uiPaused() : (this.session()?.playing ?? false) && this.controllable()));
  /** While this device claims the session, the old owner's pause on its way out is not shown. */
  readonly uiPlaying = computed(() => (this.sync.claimPending() ? (this.session()?.playing ?? false) : this.playing()));
  readonly position = computed(() => {
    if (this.pending() !== null) return 0;
    if (this.selected()) return this.target.position();
    const s = this.session();
    return s ? Math.min(this.sync.positionNow(s), s.durationSeconds ?? Infinity) : 0;
  });
  readonly duration = computed(() => {
    const pending = this.pending();
    if (pending !== null) return this.rows()[pending]?.row.durationSeconds ?? 0;
    if (this.selected()) return this.target.duration();
    const s = this.session();
    return s ? this.sync.durationNow(s) : 0;
  });
  /** The track a selected device reports, by the metadata of what it plays. */
  private readonly reportedTrack = computed<AudioRequest | null>(() => {
    const meta = this.playback.remoteFamily() === 'audio' ? this.playback.nowPlaying() : null;
    const { mediaId, itemId } = this.target.item();
    return meta && itemId ? { mediaId, itemId, title: meta.title, artist: meta.artist || undefined, album: meta.album || undefined, coverUrl: meta.posterUrl } : null;
  });
  /** Kept through the gap between two tracks of the selected device: each is a stream of its own, reported anew. */
  private readonly selectedTrack = linkedSignal<{ id: string | null; track: AudioRequest | null }, AudioRequest | null>({
    source: () => ({ id: this.remote.selectedTargetId(), track: this.reportedTrack() }),
    computation: (now, prev) => now.track ?? (prev?.source.id === now.id ? prev.value : null),
  });
  readonly track = computed<AudioRequest | null>(() => {
    if (this.selected()) return this.pendingTrack() ?? this.selectedTrack();
    const s = this.session();
    // A video session has no track: read as one, the open video view would fetch lyrics for an episode.
    if (!s || !this.sync.isAudio(s)) return null;
    const next = this.pendingTrack();
    if (next) return next;
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

  readonly stemMode = computed<StemMode>(() => this.report()?.stemMode ?? 'original');
  readonly vocalLevel = computed(() => this.report()?.vocalLevel ?? 0);
  readonly pitch = computed(() => this.report()?.pitch ?? 0);
  readonly stemsAvailable = computed(() => this.report()?.stemsAvailable ?? false);
  readonly canShiftKey = computed(() => this.report()?.canShiftKey ?? true);
  private readonly report = computed(() => (this.live() ? this.remote.targetState() : null));

  setStemMode(mode: StemMode): void {
    this.send({ action: 'karaoke', stemMode: mode });
  }

  /** A slider drag sends one command per pause, not per input. */
  setVocalLevel(level: number): void {
    const id = this.remote.observedTargetId();
    if (id) this.remote.sendCoalesced(id, { action: 'karaoke', level });
  }

  setPitch(semitones: number): void {
    this.send({ action: 'karaoke', pitch: Math.min(12, Math.max(-12, Math.round(semitones))) });
  }

  /** `track` already follows a skip sent from here. */
  readonly uiTrack = this.track;

  constructor() {
    effect((onCleanup) => {
      // A live owner plays the queue itself; a parked session still shows through this view.
      const ids = this.idsKey() && this.sync.role() !== 'owner' ? this.idsKey().split(',').map(Number) : [];
      let stale = false;
      onCleanup(() => (stale = true));
      if (!ids.length) return this.rows.set([]);
      void this.music.trackRequests(ids).then(
        (r) => {
          if (stale) return;
          this.metadata.primeTracks(r);
          this.rows.set(alignTrackRows(ids, r));
        },
        () => !stale && this.rows.set([]),
      );
    });
    // The view ends with what it follows, a selected device or the session; a takeover by this device is handed over by the player component.
    effect(() => {
      if (this.expanded() && !this.selected() && !this.sync.session()) this.fullPlayer.hide();
    });
    // The session came back to this device (a load sent from elsewhere, a local resume): the open player follows it here.
    // Only on the change to owner: right after yielding, this device still reads as owner until the new one is announced.
    let owner = this.sync.role() === 'owner';
    effect(() => {
      const now = this.sync.role() === 'owner';
      const back = now && !owner;
      owner = now;
      if (back && untracked(() => this.expanded())) this.fullPlayer.handTo('audio', false);
    });
  }

  expand(): void {
    this.fullPlayer.show('audio', true);
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
