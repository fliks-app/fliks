import { SeekbarComponent } from '../components/seekbar/seekbar';
import { CdkDrag, CdkDragDrop, CdkDragHandle, CdkDropList } from '@angular/cdk/drag-drop';
import { NgTemplateOutlet } from '@angular/common';
import { DeviceChipComponent } from '../device-chip/device-chip';
import { DropdownMenuComponent } from '../components/dropdown-menu';
import { RemotePickerListComponent } from '../remote-picker/remote-picker-list';
import { Component, ElementRef, Injector, afterNextRender, computed, effect, inject, linkedSignal, signal, untracked, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { morph, relayout } from '../utils/morph-transition';
import { PlayerBarComponent } from '../player-bar/player-bar';
import { FullPlayerState } from '../../core/services/playback/full-player-state';
import { TranslatePipe } from '@ngx-translate/core';
import {
  LucideBookmarkPlus,
  LucideArrowDown,
  LucideArrowLeft,
  LucideArrowUp,
  LucideArrowUpToLine,
  LucideChevronDown,
  LucideChevronRight,
  LucideGauge,
  LucideHeart,
  LucideListMusic,
  LucideLanguages,
  LucideMessageSquareQuote,
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
  LucideMaximize,
  LucideMinimize,
  LucideGripVertical,
  LucideListPlus,
  LucidePencil,
  LucideVolume2,
  LucideVolumeX,
  LucideX,
  LucideUserPlus,
  LucideUsers,
  LucideLogOut,
} from '@lucide/angular';
import {
  AudioPlayerService,
  SKIP_STEPS,
  SPEEDS,
  type AudioBookmark,
} from '../../core/services/audio-player/audio-player.service';
import type { SingKind } from '../../core/services/karaoke/karaoke-prep';
import type { AudioOutput } from '../../core/services/audio-player/audio-output';
import type { RemoteAction } from '../../core/services/remote.service';
import { RemoteAudioOutput } from '../../core/services/audio-player/remote-audio-output';
import type { MusicTrackRequest } from '../../core/services/audio-player/music-queue';
import { PREAMP_STEPS, REPLAY_GAINS } from '../../core/services/audio-player/replay-gain';
import { AddToPlaylistService } from '../../core/services/add-to-playlist.service';
import { LikesApiService } from '../../core/services/api/likes-api.service';
import { MediaService } from '../../core/services/api/media.service';
import { LyricsApiService } from '../../core/services/api/lyrics-api.service';
import type { AlbumDetail } from '../../core/services/api/music.models';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { AuthService } from '../../core/services/auth.service';
import { DeviceService } from '../../core/services/device.service';
import { PartyApiService } from '../../core/services/api/party-api.service';
import { PartyService } from '../../core/services/party/party.service';
import { isTrack, itemIn, programmeOf } from '../../core/services/party/party-item';
import { PartyInviteComponent } from '../../features/party/party-invite';
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
import { SwipeTrackComponent } from './swipe-track';
import { LyricsPanelComponent } from './lyrics/lyrics-panel';
import { TvRowDirective } from '../directives/tv-row.directive';
import { TvSectionDirective } from '../directives/tv-section.directive';

/** The Sing button's tooltip and label per state. */
const SING_KEYS: Record<SingKind, string> = {
  prepare: 'karaoke.sing',
  queued: 'karaoke.queued',
  running: 'karaoke.preparing_pct',
  retry: 'karaoke.failed',
  enter: 'karaoke.title',
  exit: 'karaoke.title',
};
const SLEEP_STEPS = [5, 10, 15, 30, 45, 60];

/** The persistent mini-player bar and the full-screen audio player, mounted once in the layout. The full player shows the local player, or the audio session of another device while that one is opened. */
const FULLSCREEN_KEY = 'fliks.audioPlayer.fullscreen';
const LYRICS_KEY = 'fliks.audioPlayer.lyrics';

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, String(on));
  } catch {
    /* storage unavailable: the choice lasts for the session */
  }
}

@Component({
  selector: 'app-audio-player',
  imports: [
    PartyInviteComponent,
    LucideUserPlus,
    LucideUsers,
    LucideLogOut,
    CdkDrag,
    SeekbarComponent,
    CdkDragHandle,
    CdkDropList,
    DropListSettleDirective,
    SwipeRemoveDirective,
    SwipeTrackComponent,
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
    PlayerBarComponent,
    TvSectionDirective,
    LucideBookmarkPlus,
    LucideArrowDown,
    LucideArrowLeft,
    LucideArrowUp,
    LucideArrowUpToLine,
    LucideChevronDown,
    LucideChevronRight,
    LucideGauge,
    LucideHeart,
    LucideListMusic,
    LucideLanguages,
    LucideMessageSquareQuote,
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
    LucideMaximize,
    LucideMinimize,
    LucideGripVertical,
    LucideListPlus,
    LucidePencil,
    LucideVolume2,
    LucideVolumeX,
    LucideX,
  ],
  templateUrl: './audio-player.html',
})
export class AudioPlayerComponent {
  protected readonly local = inject(AudioPlayerService);
  private readonly remoteOut = inject(RemoteAudioOutput);
  protected readonly sync = inject(SessionSyncService);
  protected readonly surface = inject(PlaybackSurface);
  private readonly fullPlayer = inject(FullPlayerState);
  /** The full player drives another device's session; it stays on it while the player closes. */
  protected readonly remoteView = this.fullPlayer.remote;
  /** Transport and seek answer: always locally, and remotely only while the owner reports itself. */
  protected readonly controllable = computed(() => !this.remoteView() || this.remoteOut.controllable());
  protected readonly canToggle = computed(() => this.controllable() || this.parkedView());
  /** A touch device uses its buttons and sets a remote's level in the device picker; a TV uses its remote. */
  protected readonly showVolume = computed(() => !this.isTv() && !this.isTouch() && this.audio.canSetVolume());
  protected readonly queueControls = computed(() => this.controllable() && (!this.remoteView() || this.audio.queue().length > 0));

  private readonly remoteCan = (action: RemoteAction) => !this.remoteView() || this.remoteOut.supports(action);
  protected readonly canPickRow = computed(() => this.controllable() && this.remoteCan('queue'));
  protected readonly canShuffle = computed(() => this.queueControls() && this.remoteCan('shuffle'));
  protected readonly canRepeat = computed(() => this.queueControls() && this.remoteCan('repeat'));

  protected get audio(): AudioOutput {
    return this.remoteView() ? this.remoteOut : this.local;
  }

  /** The mini-player's output: the local player, else a parked music session shown as this device's own. */
  protected readonly mini = computed<AudioOutput | null>(() => (this.local.track() ? this.local : this.surface.parkedMusic() ? this.remoteOut : null));
  /** The full player of a parked music session: it reads as this device's, paused, and play takes it here. */
  protected readonly parkedView = computed(() => this.remoteView() && this.remoteOut.parked());

  /** Reset by every new cover: a cover that fails to load shows the placeholder, not a broken image. */
  protected readonly coverFailed = linkedSignal<string | null | undefined, boolean>({
    source: () => this.audio.uiTrack()?.coverUrl,
    computation: () => false,
  });
  /** Kept across tracks until the new cover has loaded, so the bar doesn't flash back to grey. */
  protected readonly tint = linkedSignal<string | null | undefined, string | null>({
    source: () => this.mini()?.uiTrack()?.coverUrl,
    computation: (url, prev) => (url ? (prev?.value ?? null) : null),
  });
  private readonly likes = inject(LikesApiService);
  private readonly playlists = inject(AddToPlaylistService);
  private readonly mediaApi = inject(MediaService);
  private readonly lyricsApi = inject(LyricsApiService);
  protected readonly canEditLyrics = inject(AuthService).hasPermission('media.edit');
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  private readonly device = inject(DeviceService);
  private readonly injector = inject(Injector);
  protected readonly party = inject(PartyService);
  private readonly partyApi = inject(PartyApiService);
  protected readonly invite = viewChild(PartyInviteComponent);
  /** The host invites people; a member only shares the link, when the party has one. */
  protected readonly canInviteParty = computed(() => this.party.isHost() || !!this.party.party()?.inviteToken);
  private readonly me = inject(AuthService).user;
  /** The queue's move and drag: not on another device's session, and in a party only for the host of an all-track programme. */
  protected readonly queueLocked = computed(() => {
    if (this.remoteView()) return true;
    const rows = this.party.programme();
    return this.party.active() && !(this.party.isHost() && rows.length > 0 && rows.every(isTrack));
  });
  /** Removing a row: where the queue is editable, or in a party an upcoming row the member added. */
  protected canRemove(q: MusicTrackRequest, i: number): boolean {
    if (!this.queueLocked()) return true;
    if (this.remoteView() || !this.party.active() || this.party.isHost()) return false;
    return i > this.audio.queueIndex() && this.party.programme().find((r) => r.itemId === q.itemId)?.addedBy === this.me()?.id;
  }

  /** The user who added a track of a party's queue, empty outside a party. */
  protected author(q: MusicTrackRequest): string {
    return this.party.active() ? this.party.userName(this.party.programme().find((r) => r.itemId === q.itemId)?.addedBy ?? null) : '';
  }

  /** A solo track of the local player the user may turn into a party (not an audiobook, not a remote's session). */
  protected readonly canStartParty = computed(
    () => !this.party.active() && this.partyApi.canCreate() && this.local.musicMode() && !!this.local.track() && !this.remoteView() && !this.local.isCasting(),
  );
  /** Touch and TV get a full-height sheet; a modal dialog sits in the top layer and would hide the menu's own sheet. */
  protected readonly isTouch = this.device.isTouch;
  protected readonly isTv = this.device.isTv;
  private readonly deviceList = viewChild(RemotePickerListComponent);

  protected refreshDevices(): void {
    this.deviceList()?.refresh();
  }
  protected readonly asSheet = computed(() => this.device.isTouch() || this.device.isTv());

  protected readonly clock = formatTime;
  protected readonly miniPercent = computed(() => percentOf(this.mini() ?? this.audio));
  protected readonly chapter = computed(() => this.local.chapters()[this.local.chapterIndex()] ?? null);
  protected readonly sleepLabel = computed(() => {
    const s = this.local.sleep();
    return s?.kind === 'duration' ? this.clock(this.local.sleepLeft()) : null;
  });

  /** The viewer's choice; `lyricsShown` is what is shown, since a track without lyrics has no panel. */
  /** The Lyrics toggle, remembered across tracks and visits. */
  protected readonly lyricsOn = signal(readFlag(LYRICS_KEY));
  /** Whether the playing track has lyrics; null until known. */
  protected readonly hasLyrics = signal<boolean | null>(null);
  /** The edit tools of the lyrics panel, opened from the menu. */
  protected readonly lyricsEdit = signal(false);
  protected readonly lyricsShown = computed(() => this.lyricsOn() && (this.lyricsEdit() || this.hasLyrics() !== false));
  /** The side column fills the height and scrolls itself: the lyrics, or the desktop queue. */
  /** Desktop lists the queue inline: in place of the lyrics, or beside them when fullscreen has the room. */
  protected readonly queueInline = computed(() => this.audio.musicMode() && !this.asSheet() && (!this.lyricsShown() || this.fullscreen()));
  protected readonly panelFills = computed(() => this.lyricsShown() || (this.audio.musicMode() && !this.asSheet()));
  /** The Karaoke toggle of the lyrics panel, kept across Lyrics being hidden and shown. */
  protected readonly karaokeStage = signal(false);
  /** The mounted lyrics panel: the Sing button and the translation entries read its state. */
  protected readonly lyricsPanel = viewChild(LyricsPanelComponent);
  protected readonly singKeys = SING_KEYS;
  protected readonly queueOpen = signal(false);
  protected readonly queueEditing = signal(false);
  protected readonly selected = signal<ReadonlySet<MusicTrackRequest>>(new Set());
  /** The desktop dialog fills the viewport instead of its centred box; remembered across openings. */
  protected readonly fullscreen = signal(readFlag(FULLSCREEN_KEY));
  protected readonly menuOpen = signal(false);
  protected readonly levelOpen = signal(false);
  protected readonly fav = signal(false);
  /** The track's first credited artist, else the album's. */
  protected readonly artistId = signal<number | null>(null);
  protected readonly replayGains = REPLAY_GAINS;
  private readonly albums = new Map<number, Promise<AlbumDetail | null>>();

  constructor() {
    effect(() => {
      const t = this.audio.musicMode() ? this.audio.uiTrack() : null;
      if (t) {
        untracked(() => {
          this.lyricsEdit.set(false);
          void this.loadTrackState(t.mediaId, t.itemId);
          void this.loadLyricsState(t.itemId);
        });
      }
    });
    effect(() => {
      const c = this.likes.changed();
      if (!c) return;
      untracked(() => {
        this.albums.delete(c.mediaId);
        if (c.itemId !== undefined && c.itemId === this.audio.uiTrack()?.itemId) this.fav.set(c.liked);
      });
    });
    effect(() => {
      const expand = this.fullPlayer.open() === 'audio';
      untracked(() => this.present(expand));
    });
    effect(() => writeFlag(FULLSCREEN_KEY, this.fullscreen()));
    effect(() => writeFlag(LYRICS_KEY, this.lyricsOn()));
  }

  /** The sheet slides over the bar, which stays under it: it follows `open` with no morph. */
  protected readonly sheetOpen = computed(() => this.fullPlayer.open() === 'audio');

  /** Desktop opens the dialog out of the bar and closes back into it. */
  private present(expand: boolean): void {
    const dialog = this.dialog()?.nativeElement;
    const box = dialog?.querySelector<HTMLElement>('.player-box');
    const presented = expand ? 'audio' : null;
    if (!dialog || !box || this.fullPlayer.presented() === presented) return;
    const bar = () => document.querySelector<HTMLElement>('[data-player-bar="audio"]');
    morph({
      from: expand ? bar() : box,
      scrim: dialog,
      update: async () => {
        this.fullPlayer.presented.set(presented);
        await this.rendered();
        if (expand) dialog.showModal();
        else dialog.close();
        return expand ? box : bar();
      },
    });
  }

  protected toggleLyrics(): void {
    relayout(this.dialog()?.nativeElement ?? null, () => {
      this.lyricsEdit.set(false);
      this.lyricsOn.set(!this.lyricsShown());
      return this.rendered();
    });
  }

  /** Settles after Angular's next render; registering it schedules one. */
  private rendered(): Promise<void> {
    return new Promise((resolve) => afterNextRender(() => resolve(), { injector: this.injector }));
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
    if (this.audio.uiTrack()?.itemId !== itemId) return;
    if (track) this.fav.set(track.favourite);
    this.artistId.set(track?.artists.find((x) => x.id != null)?.id ?? a?.artists[0]?.id ?? null);
  }

  private async loadLyricsState(itemId: number): Promise<void> {
    this.hasLyrics.set(null);
    const found = await this.lyricsApi.get(itemId).then(
      (r) => r.structuredLyrics.length > 0,
      () => false,
    );
    if (this.audio.uiTrack()?.itemId === itemId) this.hasLyrics.set(found);
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

  protected async startParty(): Promise<void> {
    const queue = this.local.queue();
    const at = this.local.queueIndex();
    const current = queue[at];
    if (!current) return;
    const dto = await this.party.startHere(current.albumTitle || current.title, programmeOf(queue, current), itemIn(current), this.local.position());
    // The dialog mounts with the party: open it once rendered.
    if (dto) afterNextRender(() => this.invite()?.open(), { injector: this.injector });
  }

  protected openPartyPage(): void {
    const id = this.party.party()?.id;
    if (id != null) this.party.openPage(id);
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
  /** The queue view starts at the current track: played ones stay reachable by previous, not listed. */
  protected readonly queueStart = computed(() => Math.max(0, this.audio.queueIndex()));
  protected readonly upcoming = computed(() => this.audio.queue().slice(this.queueStart()));

  /** Rendered indexes: the current track is row 0 and stays first. */
  protected readonly sortAllowed = (index: number): boolean => index > 0;

  protected onQueueDrop(e: CdkDragDrop<unknown>): void {
    const start = this.queueStart();
    if (e.previousIndex !== e.currentIndex) this.local.moveInQueue(e.previousIndex + start, e.currentIndex + start);
  }

  protected addToPlaylist(): void {
    const t = this.audio.uiTrack();
    if (t) this.playlists.open({ itemId: t.itemId });
  }

  protected async toggleFavourite(): Promise<void> {
    const t = this.audio.uiTrack();
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

  /** Stopping ends the session for every device of the account, not just this player. */
  protected async stop(): Promise<void> {
    if (this.parkedView()) return this.sync.dismiss();
    this.sync.dismissOnPark(this.local.track()?.itemId);
    await this.local.close();
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

function percentOf(o: AudioOutput): number {
  const d = o.duration();
  return d ? Math.min(100, (o.position() / d) * 100) : 0;
}
