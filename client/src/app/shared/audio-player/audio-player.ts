import { CdkDrag, CdkDragDrop, CdkDragHandle, CdkDropList } from '@angular/cdk/drag-drop';
import { NgTemplateOutlet } from '@angular/common';
import { DeviceChipComponent } from '../device-chip/device-chip';
import { DropdownMenuComponent } from '../components/dropdown-menu';
import { RemotePickerListComponent } from '../remote-picker/remote-picker-list';
import { Component, ElementRef, computed, effect, inject, linkedSignal, signal, untracked, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import {
  LucideBookmarkPlus,
  LucideArrowDown,
  LucideArrowLeft,
  LucideArrowUp,
  LucideArrowUpToLine,
  LucideChevronDown,
  LucideSquare,
  LucideChevronRight,
  LucideGauge,
  LucideHeart,
  LucideListMusic,
  LucideMicVocal,
  LucideRepeat,
  LucideRepeat1,
  LucideShuffle,
  LucideMoon,
  LucideMusic,
  LucidePause,
  LucidePlay,
  LucideRotateCcw,
  LucideRotateCw,
  LucideSkipBack,
  LucideSkipForward,
  LucideSmartphone,
  LucideTrash2,
  LucideCheck,
  LucideEllipsisVertical,
  LucideGripVertical,
  LucideListPlus,
  LucidePencil,
  LucideVolume2,
  LucideX,
} from '@lucide/angular';
import {
  AudioPlayerService,
  SKIP_STEPS,
  SPEEDS,
  type AudioBookmark,
} from '../../core/services/audio-player/audio-player.service';
import type { AudioOutput } from '../../core/services/audio-player/audio-output';
import type { RemoteAction } from '../../core/services/remote.service';
import { RemoteAudioOutput } from '../../core/services/audio-player/remote-audio-output';
import type { MusicTrackRequest } from '../../core/services/audio-player/music-queue';
import { PREAMP_STEPS, REPLAY_GAINS } from '../../core/services/audio-player/replay-gain';
import { AddToPlaylistService } from '../../core/services/add-to-playlist.service';
import { FullPlayerState } from '../../core/services/audio-player/full-player-state';
import { LikesApiService } from '../../core/services/api/likes-api.service';
import { MediaService } from '../../core/services/api/media.service';
import { LyricsApiService } from '../../core/services/api/lyrics-api.service';
import type { AlbumDetail } from '../../core/services/api/music.models';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { AuthService } from '../../core/services/auth.service';
import { DeviceService } from '../../core/services/device.service';
import { SessionSyncService } from '../../core/services/session-sync.service';
import { PlaybackSurface } from '../../core/services/playback/playback-surface';
import { formatTime } from '../../core/utils/player.utils';
import { BottomSheetComponent } from '../components/bottom-sheet';
import { MarqueeComponent } from '../components/marquee';
import { PopoverMenuComponent } from '../components/popover-menu';
import { CachedSrcDirective } from '../directives/cached-src.directive';
import { DropListSettleDirective } from '../directives/drop-list-settle.directive';
import { SwipeRemoveDirective } from '../directives/swipe-remove.directive';
import { coverTint } from '../utils/cover-tint';
import { SwipeSkipDirective } from '../directives/swipe-skip.directive';
import { LyricsPanelComponent } from './lyrics/lyrics-panel';
import { TvRowDirective } from '../directives/tv-row.directive';
import { TvSectionDirective } from '../directives/tv-section.directive';

const SLEEP_STEPS = [5, 10, 15, 30, 45, 60];

/** The persistent mini-player bar and the full-screen audio player, mounted once in the layout. The full player shows the local player, or the audio session of another device while that one is opened. */
@Component({
  selector: 'app-audio-player',
  imports: [
    CdkDrag,
    CdkDragHandle,
    CdkDropList,
    DropListSettleDirective,
    SwipeRemoveDirective,
    SwipeSkipDirective,
    RouterLink,
    NgTemplateOutlet,
    BottomSheetComponent,
    PopoverMenuComponent,
    MarqueeComponent,
    DeviceChipComponent,
    DropdownMenuComponent,
    RemotePickerListComponent,
    TranslatePipe,
    ResolveUrlPipe,
    CachedSrcDirective,
    LyricsPanelComponent,
    TvRowDirective,
    TvSectionDirective,
    LucideBookmarkPlus,
    LucideArrowDown,
    LucideArrowLeft,
    LucideArrowUp,
    LucideArrowUpToLine,
    LucideChevronDown,
    LucideSquare,
    LucideChevronRight,
    LucideGauge,
    LucideHeart,
    LucideListMusic,
      LucideMicVocal,
    LucideRepeat,
    LucideRepeat1,
    LucideShuffle,
    LucideMoon,
    LucideMusic,
    LucidePause,
    LucidePlay,
    LucideRotateCcw,
    LucideRotateCw,
    LucideSkipBack,
    LucideSkipForward,
    LucideSmartphone,
    LucideTrash2,
    LucideCheck,
    LucideEllipsisVertical,
    LucideGripVertical,
    LucideListPlus,
    LucidePencil,
    LucideVolume2,
    LucideX,
  ],
  templateUrl: './audio-player.html',
})
export class AudioPlayerComponent {
  protected readonly local = inject(AudioPlayerService);
  private readonly remoteOut = inject(RemoteAudioOutput);
  private readonly fullPlayer = inject(FullPlayerState);
  protected readonly sync = inject(SessionSyncService);
  protected readonly surface = inject(PlaybackSurface);
  /** The full player drives another device's session. */
  protected readonly remoteView = this.remoteOut.expanded;
  /** Transport and seek answer: always locally, and remotely only while the owner reports itself. */
  protected readonly controllable = computed(() => !this.remoteView() || this.remoteOut.controllable());
  protected readonly queueControls = computed(() => this.controllable() && (!this.remoteView() || this.audio.queue().length > 0));

  private readonly remoteCan = (action: RemoteAction) => !this.remoteView() || this.remoteOut.supports(action);
  protected readonly canPickRow = computed(() => this.controllable() && this.remoteCan('queue'));
  protected readonly canShuffle = computed(() => this.queueControls() && this.remoteCan('shuffle'));
  protected readonly canRepeat = computed(() => this.queueControls() && this.remoteCan('repeat'));

  protected get audio(): AudioOutput {
    return this.remoteView() ? this.remoteOut : this.local;
  }

  /** Reset by every new cover: a cover that fails to load shows the placeholder, not a broken image. */
  protected readonly coverFailed = linkedSignal<string | null | undefined, boolean>({
    source: () => this.audio.track()?.coverUrl,
    computation: () => false,
  });
  /** Kept across tracks until the new cover has loaded, so the bar doesn't flash back to grey. */
  protected readonly tint = linkedSignal<string | null | undefined, string | null>({
    source: () => this.local.track()?.coverUrl,
    computation: (url, prev) => (url ? (prev?.value ?? null) : null),
  });
  private readonly likes = inject(LikesApiService);
  private readonly playlists = inject(AddToPlaylistService);
  private readonly mediaApi = inject(MediaService);
  private readonly lyricsApi = inject(LyricsApiService);
  protected readonly canEditLyrics = inject(AuthService).hasPermission('media.edit');
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  private readonly device = inject(DeviceService);
  /** Touch and TV get a full-height sheet; a modal dialog sits in the top layer and would hide the menu's own sheet. */
  protected readonly isTouch = this.device.isTouch;
  protected readonly isTv = this.device.isTv;
  private readonly deviceList = viewChild(RemotePickerListComponent);

  protected refreshDevices(): void {
    this.deviceList()?.refresh();
  }
  protected readonly asSheet = computed(() => this.device.isTouch() || this.device.isTv());

  protected readonly clock = formatTime;
  protected readonly swipeDx = signal(0);
  /** Swipe offset as a fraction of the title width: the title is gone at 40%, the neighbour shows from 50% to 80%. */
  protected readonly swipeOut = computed(() => Math.max(0, 1 - Math.abs(this.swipeDx()) / 0.4));
  protected readonly swipeIn = computed(() => Math.min(1, Math.max(0, (Math.abs(this.swipeDx()) - 0.5) / 0.3)));
  /** No swipe past either end of the queue, nor on a single track that repeat-all would loop onto itself. */
  protected readonly swipeable = computed(() => {
    const many = this.local.queue().length > 1;
    return { next: many && !!this.local.neighbour(1), previous: many && !!this.local.neighbour(-1) };
  });
  protected readonly peek = computed(() => (this.swipeDx() ? this.local.neighbour(this.swipeDx() < 0 ? 1 : -1) : null));
  protected readonly percent = computed(() => {
    const d = this.audio.duration();
    return d ? Math.min(100, (this.audio.position() / d) * 100) : 0;
  });
  /** The slider value while the user drags, so `timeupdate` doesn't snap the thumb back. */
  protected readonly scrub = signal<number | null>(null);
  protected readonly shown = computed(() => {
    const s = this.scrub();
    return s === null ? this.audio.position() : (s / 1000) * this.audio.duration();
  });
  protected readonly chapter = computed(() => this.local.chapters()[this.local.chapterIndex()] ?? null);
  protected readonly sleepLabel = computed(() => {
    const s = this.local.sleep();
    return s?.kind === 'duration' ? this.clock(this.local.sleepLeft()) : null;
  });

  /** The viewer's choice; `lyricsShown` is what is shown, since a track without lyrics has no panel. */
  protected readonly lyricsOn = signal(false);
  /** Whether the playing track has lyrics; null until known. */
  protected readonly hasLyrics = signal<boolean | null>(null);
  /** The edit tools of the lyrics panel, opened from the menu. */
  protected readonly lyricsEdit = signal(false);
  protected readonly lyricsShown = computed(() => this.lyricsOn() && (this.lyricsEdit() || this.hasLyrics() !== false));
  protected readonly queueOpen = signal(false);
  protected readonly queueEditing = signal(false);
  protected readonly selected = signal<ReadonlySet<MusicTrackRequest>>(new Set());
  protected readonly menuOpen = signal(false);
  protected readonly levelOpen = signal(false);
  protected readonly fav = signal(false);
  /** The track's first credited artist, else the album's. */
  protected readonly artistId = signal<number | null>(null);
  protected readonly replayGains = REPLAY_GAINS;
  private readonly albums = new Map<number, Promise<AlbumDetail | null>>();

  constructor() {
    effect(() => {
      const t = this.audio.musicMode() ? this.audio.track() : null;
      if (t) {
        untracked(() => {
          this.lyricsEdit.set(false);
          void this.loadTrackState(t.mediaId, t.itemId);
          void this.loadLyricsState(t.itemId);
        });
      }
    });
    // This device took the session over: the open dialog moves to the local output once its track is up, else it closes.
    effect(() => {
      const s = this.sync.session();
      if (!this.remoteView() || !s || this.sync.role() !== 'owner') return;
      const track = this.local.track();
      untracked(() => {
        if (track?.itemId === s.item.id) this.fullPlayer.remote.set(false);
        else if (!track && !this.local.loading() && !this.sync.claimPending()) this.fullPlayer.hide();
      });
    });
    effect(() => {
      const c = this.likes.changed();
      if (!c) return;
      untracked(() => {
        this.albums.delete(c.mediaId);
        if (c.itemId !== undefined && c.itemId === this.audio.track()?.itemId) this.fav.set(c.liked);
      });
    });
    effect(() => {
      const el = this.dialog()?.nativeElement;
      if (!el) return;
      if (this.audio.expanded() && !el.open) el.showModal();
      else if (!this.audio.expanded() && el.open) el.close();
    });
  }

  protected onSeek(e: Event): void {
    void this.audio.seek((Number((e.target as HTMLInputElement).value) / 1000) * this.audio.duration());
    this.scrub.set(null);
  }

  protected toggleLyrics(): void {
    this.lyricsEdit.set(false);
    this.lyricsOn.set(!this.lyricsShown());
  }

  protected editLyrics(): void {
    this.lyricsOn.set(true);
    this.lyricsEdit.set(true);
  }

  protected cycleRate(): void {
    this.local.setRate(SPEEDS[(SPEEDS.indexOf(this.local.rate()) + 1) % SPEEDS.length]);
  }

  protected cycleSkipBack(): void {
    this.local.setSkips(next(SKIP_STEPS, this.local.skipBack()), this.local.skipForward());
  }

  protected cycleSkipForward(): void {
    this.local.setSkips(this.local.skipBack(), next(SKIP_STEPS, this.local.skipForward()));
  }

  /** Off, then each duration, then the end of the chapter, then off. */
  protected cycleSleep(): void {
    const s = this.local.sleep();
    if (!s) this.local.setSleep({ minutes: SLEEP_STEPS[0] });
    else if (s.kind === 'chapter') this.local.setSleep(null);
    else {
      const minutes = SLEEP_STEPS[SLEEP_STEPS.indexOf(s.minutes) + 1];
      this.local.setSleep(minutes ? { minutes } : 'chapter');
    }
  }

  /** The caller's favourite and rating come with the album detail. */
  private async loadTrackState(mediaId: number, itemId: number): Promise<void> {
    this.fav.set(false);
    this.artistId.set(null);
    let album = this.albums.get(mediaId);
    if (!album) {
      album = this.mediaApi
        .getOne(mediaId)
        .then((m) => (m as { album?: AlbumDetail }).album ?? null)
        .catch(() => null);
      this.albums.set(mediaId, album);
    }
    const a = await album;
    const track = a?.tracks.find((x) => x.itemId === itemId);
    if (this.audio.track()?.itemId !== itemId) return;
    if (track) this.fav.set(track.favourite);
    this.artistId.set(track?.artists.find((x) => x.id != null)?.id ?? a?.artists[0]?.id ?? null);
  }

  private async loadLyricsState(itemId: number): Promise<void> {
    this.hasLyrics.set(null);
    const found = await this.lyricsApi.get(itemId).then(
      (r) => r.structuredLyrics.length > 0,
      () => false,
    );
    if (this.audio.track()?.itemId === itemId) this.hasLyrics.set(found);
  }

  protected async tintFrom(img: HTMLImageElement): Promise<void> {
    const src = img.currentSrc;
    const tint = await coverTint(src);
    if (img.isConnected && img.currentSrc === src) this.tint.set(tint);
  }

  protected toggleSelected(q: MusicTrackRequest): void {
    const next = new Set(this.selected());
    if (!next.delete(q)) next.add(q);
    this.selected.set(next);
  }

  /** Editing selects a row; the playing one is neither selectable nor a restart. */
  protected onQueueRowClick(q: MusicTrackRequest, i: number): void {
    if (!this.queueEditing()) void this.audio.playQueueAt(i);
    else if (i !== this.audio.queueIndex()) this.toggleSelected(q);
  }

  protected closeMenu(): void {
    this.menuOpen.set(false);
    this.levelOpen.set(false);
  }

  protected closeQueue(): void {
    this.queueOpen.set(false);
    this.stopEditingQueue();
  }

  protected stopEditingQueue(): void {
    this.queueEditing.set(false);
    this.selected.set(new Set());
  }

  /** Puts the selected tracks right after the playing one, in queue order. */
  protected moveSelectedToTop(): void {
    const current = this.local.queue()[this.local.queueIndex()];
    let slot = 0;
    for (const q of this.local.queue().filter((t) => this.selected().has(t) && t !== current)) {
      const from = this.local.queue().indexOf(q);
      const cur = this.local.queueIndex();
      this.local.moveInQueue(from, from > cur ? cur + 1 + slot : cur + slot);
      slot++;
    }
    this.selected.set(new Set());
  }

  protected removeSelected(): void {
    const indexes = this.local.queue().flatMap((t, i) => (this.selected().has(t) ? [i] : []));
    for (const i of indexes.reverse()) this.local.removeFromQueue(i);
    this.selected.set(new Set());
  }

  /** The playing track stays put, and a track never crosses it. */
  protected readonly sortAllowed = (index: number, drag: CdkDrag<number>): boolean => {
    const cur = this.audio.queueIndex();
    return index !== cur && drag.data > cur === index > cur;
  };

  protected onQueueDrop(e: CdkDragDrop<unknown>): void {
    if (e.previousIndex !== e.currentIndex) this.local.moveInQueue(e.previousIndex, e.currentIndex);
  }

  protected addToPlaylist(): void {
    const t = this.audio.track();
    if (t) this.playlists.open({ itemId: t.itemId });
  }

  protected async toggleFavourite(): Promise<void> {
    const t = this.audio.track();
    if (!t) return;
    const target = { mediaId: t.mediaId, itemId: t.itemId };
    const was = this.fav();
    this.fav.set(!was);
    try {
      await (was ? this.likes.unlike(target) : this.likes.like(target));
    } catch {
      this.fav.set(was);
    }
  }

  protected cyclePreamp(): void {
    this.local.setPreamp(next(PREAMP_STEPS, this.local.preamp()));
  }

  protected goTo(b: AudioBookmark): void {
    void this.local.seek(b.position);
  }

  protected async listenHere(): Promise<void> {
    await this.sync.playHere();
  }

  protected onDialogClose(): void {
    this.audio.collapse();
  }
}

function next<T>(steps: T[], value: T): T {
  return steps[(steps.indexOf(value) + 1) % steps.length];
}
