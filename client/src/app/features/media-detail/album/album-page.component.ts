import { ChangeDetectionStrategy, Component, ElementRef, afterRenderEffect, computed, effect, inject, input, linkedSignal, signal, untracked, viewChild } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucideCircleAlert, LucideClock, LucideEllipsisVertical, LucideHeart, LucideListPlus, LucidePause, LucidePlay, LucidePlus, LucideShuffle } from '@lucide/angular';
import { translatePlural, TranslatePluralPipe } from '../../../core/pipes/translate-plural.pipe';
import { AddToPlaylistService } from '../../../core/services/add-to-playlist.service';
import { AudioPlayerService } from '../../../core/services/audio-player/audio-player.service';
import { DownloadProgressService } from '../../../core/services/download-progress.service';
import type { KaraokeJobChanged } from '../../../core/services/api/karaoke.models';
import { SseService } from '../../../core/services/sse.service';
import { MusicDownloadsService } from '../../../core/services/music-downloads.service';
import { LikesApiService } from '../../../core/services/api/likes-api.service';
import type { Media } from '../../../core/services/api/media.service';
import { RequestsService, titleRef, type TitleRequestState } from '../../../core/services/api/requests.service';
import { MusicApiService } from '../../../core/services/api/music-api.service';
import type { AlbumCandidate, Track } from '../../../core/services/api/music.models';
import { PartyService } from '../../../core/services/party/party.service';
import { IdentifyModalService } from '../../../core/services/identify-modal.service';
import { AuthService } from '../../../core/services/auth.service';
import { CardActionsService, type CardAction } from '../../../core/services/card-actions.service';
import { MediaActionsController } from '../../../shared/utils/media-actions-controller';
import { toCardAction } from '../../../shared/utils/media-menu';
import { AddDialogComponent } from '../../../shared/components/add-dialog/add-dialog';
import type { AddResult } from '../../../shared/components/add-dialog/add-plan';
import { MediaWantsComponent } from '../../../shared/components/media-wants/media-wants';
import type { MediaActionHandlers } from '../../../core/plugin-ui/media-action-registry';
import { DetailHeroComponent } from '../../../shared/components/detail-hero/detail-hero';
import { heroDesktopLayout } from '../../../shared/components/hero-base/hero-base';
import { DetailSectionComponent } from '../../../shared/components/detail-section/detail-section';
import { HorizontalScrollerComponent } from '../../../shared/components/horizontal-scroller';
import { FactsGridComponent, type Fact } from '../../../shared/components/facts-grid/facts-grid';
import { LikeController } from '../../../shared/utils/like-controller';
import {
  artistLine, flashTrack, formatDuration, groupByWork, groupDiscs, rowStates, splitOrphans, toTrackRequest, versionChip,
  type AlbumFacts, type Disc, type RowLeaf, type WorkSection,
} from '../../music/music-utils';
import { MusicDownloadButtonComponent } from '../../../shared/components/music-download-button/music-download-button';
import { ModalHeaderComponent } from '../../../shared/components/modal-header';
import { MediaCardComponent } from '../../../shared/components/media-card/media-card';
import { TrackDownloadGlyphComponent } from '../../../shared/components/track-download-glyph/track-download-glyph';
import { mediaDetailLink } from '../../../core/media-kinds';
import { MediaService } from '../../../core/services/api/media.service';
import { asAlbumMedia, versionMeta } from './album-media';
import { mediaTitleKey } from '../request-flow-controller';

interface DiscView {
  disc: Disc;
  sections: WorkSection[];
}


/** The page of an album, rendered by the media detail page for the `album` kind. */
@Component({
  selector: 'app-album-page',
  imports: [
    NgTemplateOutlet, RouterLink, TranslatePipe, TranslatePluralPipe, DetailHeroComponent, TrackDownloadGlyphComponent, MediaCardComponent, DetailSectionComponent, HorizontalScrollerComponent, FactsGridComponent,
    ModalHeaderComponent, MediaWantsComponent, MusicDownloadButtonComponent, AddDialogComponent,
    LucideCircleAlert, LucideClock, LucideHeart, LucideListPlus, LucidePause, LucidePlay, LucidePlus, LucideShuffle, LucideEllipsisVertical,
  ],
  templateUrl: './album-page.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlbumPageComponent {
  /** The card handoff (list shape) until the full album lands. */
  readonly media = input.required<Media>();

  private readonly music = inject(MusicApiService);
  private readonly likes = inject(LikesApiService);
  protected readonly player = inject(AudioPlayerService);
  private readonly playlists = inject(AddToPlaylistService);
  private readonly identifyModal = inject(IdentifyModalService);
  private readonly auth = inject(AuthService);
  private readonly requestsApi = inject(RequestsService);
  private readonly mediaApi = inject(MediaService);
  protected readonly party = inject(PartyService);
  protected readonly downloads = inject(MusicDownloadsService);
  private readonly progress = inject(DownloadProgressService);
  protected readonly like = new LikeController(
    { media: () => this.media(), episodeMode: () => false, focusedEpisode: () => null },
    this.likes,
  );

  protected readonly album = computed(() => asAlbumMedia(this.media())?.album ?? null);
  protected readonly release = computed(() => this.album()?.release ?? null);
  /** The caller's heart as just set, over the loaded tracks. */
  private readonly overrides = linkedSignal<Media, Map<number, Partial<Track>>>({ source: this.media, computation: () => new Map() });
  protected readonly tracks = computed(() =>
    (this.album()?.tracks ?? [])
      .map((t) => ({ ...t, ...this.overrides().get(t.itemId) })),
  );
  private readonly cardActions = inject(CardActionsService);
  private readonly translate = inject(TranslateService);
  private readonly activeTrack = signal<Track | null>(null);
  private readonly trackActions = new MediaActionsController({
    base: () => ({ mediaId: this.media().id, kind: 'album', level: 'item', itemId: this.activeTrack()?.itemId }),
    facts: () => ({ isAdmin: this.auth.hasPermission('settings.access'), hasFiles: !!this.activeTrack()?.hasFile, identified: true }),
  });
  protected readonly discs = computed<DiscView[]>(() =>
    groupDiscs(this.split().listed).map((disc) => ({ disc, sections: groupByWork(disc.tracks) })),
  );
  private readonly split = computed(() => splitOrphans(this.tracks()));
  /** Files the ingest could not pair with a track of the release. */
  protected readonly orphanFiles = computed(() => this.split().orphans);
  protected readonly playable = computed(() => this.tracks().filter((t) => t.hasFile));
  protected readonly orphaned = computed(() => !!this.album()?.orphaned);
  protected readonly desktop = heroDesktopLayout();
  /** Identify lists the releases the files may be, instead of the title search of the other kinds. */
  protected readonly actions = computed<MediaActionHandlers>(() => ({
    'media.identify': () => void this.review(),
    'media.details': () => this.detailsDialog()?.nativeElement.showModal(),
    ...(this.auth.hasPermission('media.edit') && { 'media.edit-profiles': () => this.openWants() }),
  }));
  /** A viewer who may only request asks for a missing track from its row. */
  private readonly titleKey = computed(() => mediaTitleKey(this.media()));
  protected readonly canRequest = computed(
    () => !this.auth.hasPermission('media.create') && this.auth.hasPermission('requests.create') && this.titleKey() != null && this.album() != null,
  );
  protected readonly canAdd = computed(() => this.auth.hasPermission('media.create') && this.titleKey() != null && this.album() != null);
  private readonly requestState = signal<TitleRequestState | null>(null);
  private readonly asked = signal<ReadonlySet<string>>(new Set());
  private pendingRecording: string | null = null;
  private readonly addDialog = viewChild(AddDialogComponent);

  private readonly askedAll = signal(false);
  private readonly karaokeLive = linkedSignal<Media, Map<number, Track['karaoke']>>({ source: this.media, computation: () => new Map() });
  private readonly leaves = computed<RowLeaf[]>(() =>
    (this.progress.progress().get(this.media().id)?.leaves ?? []).map((l) => ({ percent: l.state === 'searching' ? null : l.percent, itemIds: l.itemIds })),
  );
  private isRequested(t: Track): boolean {
    const s = this.requestState();
    return !!(this.askedAll() || s?.wholeAlbumRequested || (t.recordingId && (this.asked().has(t.recordingId) || s?.requestedRecordings?.includes(t.recordingId))));
  }

  /** The one state per track the row draws: owned, downloading, wanted, failed or unwanted. */
  protected readonly rowState = computed(() =>
    rowStates(this.tracks(), {
      leaves: this.leaves(),
      requested: (t) => this.isRequested(t),
      admin: this.auth.hasPermission('media.create'),
      karaoke: (t) => (this.karaokeLive().has(t.itemId) ? this.karaokeLive().get(t.itemId) : t.karaoke),
    }),
  );
  protected readonly unwantedCount = computed(() => [...this.rowState().values()].filter((s) => s.kind === 'unwanted').length);
  /** From the loaded album, not the live tracks: the controls stay once the last track is wanted. */
  protected readonly hasUnwanted = computed(() => (this.album()?.tracks ?? []).some((t) => !t.hasFile && !t.monitored && !t.orphaned));
  /** Mean percent of the album's downloads; null while none is known, undefined when nothing downloads. */
  protected readonly albumProgress = computed(() => {
    const e = this.progress.progress().get(this.media().id);
    return e ? e.percent : undefined;
  });

  protected addTrack(t: Track): void {
    const key = this.titleKey();
    if (!key || !t.recordingId) return;
    const [provider, externalId] = titleRef(key);
    this.pendingRecording = t.recordingId;
    void this.addDialog()?.add({ kind: 'album', provider, externalId, title: this.media().title, recording: { externalId: t.recordingId, albumExternalId: externalId }, mode: this.canAdd() ? 'import' : 'request' });
  }

  protected onRequested(r: AddResult): void {
    const ids = r.recordings ?? (this.pendingRecording ? [this.pendingRecording] : []);
    this.asked.update((s) => new Set([...s, ...ids]));
    if (!ids.length) this.askedAll.set(true);
    this.pendingRecording = null;
  }

  /** A viewer who may only request asks for every missing track. */
  protected requestAlbum(): void {
    const key = this.titleKey();
    if (!key) return;
    const [provider, externalId] = titleRef(key);
    this.pendingRecording = null;
    void this.addDialog()?.add({ kind: 'album', provider, externalId, title: this.media().title, mode: 'request' });
  }

  /** Monitors every track of the release in one call. */
  protected async wantAll(): Promise<void> {
    try {
      await this.mediaApi.update(this.media().id, { monitored: true });
      for (const t of this.tracks()) this.patch(t.itemId, { monitored: true });
      this.askedAll.set(true);
    } catch {
      // The global interceptor toasts the failure.
    }
  }

  protected readonly wantsOpen = signal(false);
  private readonly wantsDialog = viewChild<ElementRef<HTMLDialogElement>>('wantsDialog');

  private readonly focusTrack = inject(ActivatedRoute).snapshot.queryParamMap.get('track');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    let focused = !this.focusTrack;
    afterRenderEffect(() => {
      if (!focused && this.tracks().length) focused = flashTrack(this.host.nativeElement, this.focusTrack!);
    });
    inject(SseService).karaokeEvents.pipe(takeUntilDestroyed()).subscribe((e) => {
      if (e.type !== 'karaoke.job_changed') return;
      const j = e as unknown as KaraokeJobChanged;
      const live = j.state === 'queued' || j.state === 'running';
      this.karaokeLive.update((m) => new Map(m).set(j.itemId, live ? { state: j.state as 'queued' | 'running', stage: j.stage, progress: j.progress ?? null } : null));
    });
    effect(() => {
      const key = this.titleKey();
      if (!this.canRequest() || !key) return;
      untracked(() => void this.requestsApi.getTitleState(key, 'album').then((s) => this.requestState.set(s), () => undefined));
    });
  }

  private openWants(): void {
    this.wantsOpen.set(true);
    this.wantsDialog()?.nativeElement.showModal();
  }
  protected readonly artistsText = computed(() => artistLine(this.album()?.artists ?? []));
  protected readonly coverUrl = computed(() => this.release()?.coverUrl ?? this.media().posterUrl);
  protected readonly duration = computed(() => formatDuration(this.tracks().reduce((s, t) => s + (t.durationSeconds ?? 0), 0)));
  protected readonly facts = computed<Fact[]>(() => {
    const e = this.release();
    return [
      { label: 'music.country', value: e?.country },
      { label: 'music.media', value: e?.media },
      { label: 'music.label', value: e?.label },
      { label: 'music.catalog_number', value: e?.catalogNumber },
      { label: 'music.barcode', value: e?.barcode },
      { label: 'music.release_date', value: e?.releaseDate, format: 'date' },
    ];
  });
  protected readonly line = artistLine;
  protected readonly formatTime = formatDuration;

  private tracksText(n: number | null): string {
    return n ? translatePlural(this.translate, 'music.track_count', n) : '';
  }

  /** The release's own label, only when the group has several releases. */
  protected readonly versionLabel = computed(() => versionChip(this.release()?.disambiguation, this.album()?.versions.length ?? 0));

  /** A held version is its album page; a missing one opens its release preview. */
  protected readonly otherVersions = computed(() =>
    (this.album()?.versions ?? [])
      .filter((v) => v.mediaId !== this.media().id)
      .map((v) => ({
        id: v.releaseId,
        title: v.disambiguation ?? this.translate.instant('music.version_standard'),
        subtitle: versionMeta(v, this.tracksText(v.trackCount)),
        link: v.mediaId != null ? mediaDetailLink('album', v.mediaId) : ['/add/album', 'musicbrainz', v.releaseId],
        missing: v.mediaId == null,
      })),
  );

  private request(t: Track) {
    const m = this.media();
    const facts: AlbumFacts = {
      mediaId: m.id,
      title: m.title,
      coverUrl: this.coverUrl(),
      artists: this.artistsText(),
      albumGain: this.release()?.albumGain ?? null,
      albumPeak: this.release()?.albumPeak ?? null,
    };
    return toTrackRequest(t, facts);
  }

  protected play(startItemId?: number): Promise<void> {
    const list = this.playable();
    const start = startItemId == null ? 0 : Math.max(0, list.findIndex((t) => t.itemId === startItemId));
    return this.player.playTracks(list.map((t) => this.request(t)), start);
  }

  protected readonly playingItemId = computed(() => (this.player.musicMode() ? this.player.track()?.itemId : null));
  private readonly albumLoaded = computed(() => this.player.musicMode() && this.player.track()?.mediaId === this.media().id);
  protected readonly albumPlaying = computed(() => this.albumLoaded() && this.player.playing());

  /** Pauses or resumes this album when it is the one loaded, else starts it. */
  protected togglePlay(): void {
    if (this.albumLoaded()) this.player.toggle();
    else void this.play();
  }

  protected readonly playableIds = computed(() => this.playable().map((t) => t.itemId));
  protected readonly albumSource = () => Promise.resolve(this.playable().map((t) => this.request(t)));

  protected toggleDownload(t: Track): void {
    void (this.downloads.itemIds().has(t.itemId) ? this.downloads.remove([t.itemId]) : this.downloads.download([this.request(t)]));
  }

  protected addAlbumToPlaylist(): void {
    this.playlists.open({ mediaId: this.media().id });
  }

  protected addToPlaylist(t: Track): void {
    this.playlists.open({ itemId: t.itemId });
  }

  /** The track's own actions, then the acquisition rows, in the panel the other kinds use. */
  protected openTrackMenu(t: Track, anchor: HTMLElement): void {
    this.activeTrack.set(t);
    const own = (key: string, icon: string, run: () => void, disabled = false): CardAction => ({
      label: this.translate.instant(key), icon, run, disabled, section: 'track',
    });
    const actions: CardAction[] = [
      ...(this.canPlayNext() ? [own('music.play_next', 'list-start', () => this.enqueue(t, 'next'), !t.hasFile)] : []),
      own('music.add_to_queue', 'list-end', () => this.enqueue(t, 'last'), !t.hasFile),
      own('playlists.add_to_playlist_title', 'list-plus', () => this.addToPlaylist(t), !t.hasFile),
      ...(this.downloads.available() && t.hasFile
        ? [own(this.downloads.itemIds().has(t.itemId) ? 'downloads.remove_from_device' : 'downloads.download', 'download', () => this.toggleDownload(t))]
        : []),
      ...(this.rowState().get(t.itemId)?.kind === 'failed' && this.retrySearch()
        ? [own('music.retry_search', 'search', this.retrySearch()!)]
        : []),
      ...(this.desktop() ? [] : [own(t.favourite ? 'music.unfavourite' : 'music.favourite', 'heart', () => void this.toggleFavourite(t))]),
      ...(this.creditGroups(t).length ? [own('music.credits', 'users', () => this.openCredits(t))] : []),
      ...this.trackActions.rows().map((r) => toCardAction(r)),
    ];
    this.cardActions.register({ actions, anchor, placement: 'button', title: t.title, subtitle: this.artistsText(), imageUrl: this.coverUrl(), imageAspect: 'square' });
    this.cardActions.show();
  }

  /** The track's own "grab best" row, when a provider serves it. */
  private retrySearch(): (() => void) | null {
    const rows = this.trackActions.rows().flatMap((r) => r.children ?? [r]);
    return rows.find((r) => r.actionId === 'item.grab-best')?.run ?? null;
  }

  /** A member of a party that takes turns has no "next": the server places each song by turn. */
  private canPlayNext(): boolean {
    return !(this.party.active() && this.party.party()?.rotation && !this.party.isHost());
  }

  protected enqueue(t: Track, where: 'next' | 'last'): void {
    this.player.enqueueTracks([this.request(t)], where);
  }

  protected readonly creditsOf = signal<Track | null>(null);
  private readonly detailsDialog = viewChild<ElementRef<HTMLDialogElement>>('detailsDialog');
  private readonly creditsDialog = viewChild<ElementRef<HTMLDialogElement>>('creditsDialog');
  protected readonly candidates = signal<AlbumCandidate[] | null>(null);
  protected readonly reviewing = signal(false);

  /** Lists the releases the files may be; the viewer picks one to identify the album. */
  protected async review(): Promise<void> {
    this.reviewing.set(true);
    try {
      this.candidates.set(await this.music.candidates(this.media().id));
    } catch {
      this.candidates.set(null);
    } finally {
      this.reviewing.set(false);
    }
  }

  protected async pick(c: AlbumCandidate): Promise<void> {
    this.reviewing.set(true);
    try {
      await this.music.identify(this.media().id, c);
      this.candidates.set(null);
      this.identifyModal.markIdentified();
    } catch {
      // The global interceptor toasts the failure.
    } finally {
      this.reviewing.set(false);
    }
  }

  private patch(itemId: number, p: Partial<Track>): void {
    this.overrides.update((m) => new Map(m).set(itemId, { ...m.get(itemId), ...p }));
  }

  protected async toggleFavourite(t: Track): Promise<void> {
    const target = { mediaId: this.media().id, episodeId: t.itemId };
    this.patch(t.itemId, { favourite: !t.favourite });
    try {
      await (t.favourite ? this.likes.unlike(target) : this.likes.like(target));
    } catch {
      this.patch(t.itemId, { favourite: t.favourite });
    }
  }

  protected openCredits(t: Track): void {
    this.creditsOf.set(t);
    this.creditsDialog()?.nativeElement.showModal();
  }

  protected creditGroups(t: Track): { role: string; names: string }[] {
    const by = new Map<string, string[]>();
    for (const c of t.credits) by.set(c.role, [...(by.get(c.role) ?? []), c.instrument ? `${c.name} (${c.instrument})` : c.name]);
    return [...by].map(([role, names]) => ({ role, names: names.join(', ') }));
  }
}
