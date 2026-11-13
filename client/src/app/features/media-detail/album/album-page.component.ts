import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, linkedSignal, signal, viewChild } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucideEllipsisVertical, LucideHeart, LucideListPlus, LucidePause, LucidePlay, LucideShuffle } from '@lucide/angular';
import { TranslatePluralPipe } from '../../../core/pipes/translate-plural.pipe';
import { AddToPlaylistService } from '../../../core/services/add-to-playlist.service';
import { AudioPlayerService } from '../../../core/services/audio-player/audio-player.service';
import { MusicDownloadsService } from '../../../core/services/music-downloads.service';
import { LikesApiService } from '../../../core/services/api/likes-api.service';
import type { Media } from '../../../core/services/api/media.service';
import { MusicApiService } from '../../../core/services/api/music-api.service';
import type { AlbumCandidate, AlbumEdition, Track } from '../../../core/services/api/music.models';
import { PartyService } from '../../../core/services/party/party.service';
import { IdentifyModalService } from '../../../core/services/identify-modal.service';
import { AuthService } from '../../../core/services/auth.service';
import { CardActionsService, type CardAction } from '../../../core/services/card-actions.service';
import { MediaActionsController } from '../../../shared/utils/media-actions-controller';
import { toCardAction } from '../../../shared/utils/media-menu';
import { MediaWantsComponent } from '../../../shared/components/media-wants/media-wants';
import type { MediaActionHandlers } from '../../../core/plugin-ui/media-action-registry';
import { DetailHeroComponent } from '../../../shared/components/detail-hero/detail-hero';
import { heroDesktopLayout } from '../../../shared/components/hero-base/hero-base';
import { DetailSectionComponent } from '../../../shared/components/detail-section/detail-section';
import { FactsGridComponent, type Fact } from '../../../shared/components/facts-grid/facts-grid';
import { TvSelectDirective } from '../../../shared/directives/tv-select.directive';
import { LikeController } from '../../../shared/utils/like-controller';
import {
  artistLine, formatDuration, groupByWork, groupDiscs, toTrackRequest, type AlbumFacts, type Disc, type WorkSection,
} from '../../music/music-utils';
import { MusicDownloadButtonComponent } from '../../../shared/components/music-download-button/music-download-button';
import { ModalHeaderComponent } from '../../../shared/components/modal-header';
import { TrackLineComponent } from '../../music/track-line.component';
import { asAlbumMedia, defaultEditionId } from './album-media';

interface DiscView {
  disc: Disc;
  sections: WorkSection[];
}


/** The page of an album, rendered by the media detail page for the `album` kind. */
@Component({
  selector: 'app-album-page',
  imports: [
    FormsModule, NgTemplateOutlet, RouterLink, TranslatePipe, TranslatePluralPipe, TvSelectDirective, DetailHeroComponent, TrackLineComponent, DetailSectionComponent, FactsGridComponent,
    ModalHeaderComponent, MediaWantsComponent, MusicDownloadButtonComponent,
    LucideEllipsisVertical, LucideHeart, LucideListPlus, LucidePause, LucidePlay, LucideShuffle,
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
  protected readonly party = inject(PartyService);
  protected readonly downloads = inject(MusicDownloadsService);
  protected readonly like = new LikeController(
    { media: () => this.media(), episodeMode: () => false, focusedEpisode: () => null },
    this.likes,
  );

  protected readonly album = computed(() => asAlbumMedia(this.media())?.album ?? null);
  protected readonly editionId = linkedSignal(() => {
    const a = this.album();
    return a ? defaultEditionId(a) : null;
  });
  protected readonly edition = computed<AlbumEdition | null>(() => this.album()?.editions.find((e) => e.id === this.editionId()) ?? null);
  /** The caller's heart as just set, over the loaded tracks. */
  private readonly overrides = linkedSignal<Media, Map<number, Partial<Track>>>({ source: this.media, computation: () => new Map() });
  protected readonly tracks = computed(() =>
    (this.album()?.tracks ?? [])
      .filter((t) => t.editionId === this.editionId())
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
    groupDiscs(this.tracks()).map((disc) => ({ disc, sections: groupByWork(disc.tracks) })),
  );
  protected readonly playable = computed(() => this.tracks().filter((t) => t.hasFile));
  protected readonly orphaned = computed(() => !!this.album()?.orphaned || !!this.edition()?.orphaned);
  protected readonly desktop = heroDesktopLayout();
  /** Identify lists the releases the files may be, instead of the title search of the other kinds. */
  protected readonly actions = computed<MediaActionHandlers>(() => ({
    'media.identify': () => void this.review(),
    'media.details': () => this.detailsDialog()?.nativeElement.showModal(),
    ...(this.auth.hasPermission('media.edit') && { 'media.edit-profiles': () => this.openWants() }),
  }));
  protected readonly wantsOpen = signal(false);
  private readonly wantsDialog = viewChild<ElementRef<HTMLDialogElement>>('wantsDialog');

  private openWants(): void {
    this.wantsOpen.set(true);
    this.wantsDialog()?.nativeElement.showModal();
  }
  protected readonly artistsText = computed(() => artistLine(this.album()?.artists ?? []));
  protected readonly coverUrl = computed(() => this.edition()?.coverUrl ?? this.media().posterUrl);
  protected readonly duration = computed(() => formatDuration(this.tracks().reduce((s, t) => s + (t.durationSeconds ?? 0), 0)));
  protected readonly facts = computed<Fact[]>(() => {
    const e = this.edition();
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

  protected editionLabel(e: AlbumEdition): string {
    return [e.title, e.country, e.media, e.label, e.releaseDate?.slice(0, 4)].filter(Boolean).join(' · ') || `#${e.id}`;
  }

  private request(t: Track) {
    const m = this.media();
    const facts: AlbumFacts = {
      mediaId: m.id,
      title: m.title,
      coverUrl: this.coverUrl(),
      artists: this.artistsText(),
      albumGain: this.edition()?.albumGain ?? null,
      albumPeak: this.edition()?.albumPeak ?? null,
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
    const own = (key: string, icon: string, run: () => void, disabled = false, params?: object): CardAction => ({
      label: this.translate.instant(key, params), icon, run, disabled, section: 'track',
    });
    const actions: CardAction[] = [
      own('music.play_next', 'list-start', () => this.enqueue(t, 'next'), !t.hasFile),
      own('music.add_to_queue', 'list-end', () => this.enqueue(t, 'last'), !t.hasFile),
      own('playlists.add_to_playlist_title', 'list-plus', () => this.addToPlaylist(t), !t.hasFile),
      ...(this.downloads.available() && t.hasFile
        ? [own(this.downloads.itemIds().has(t.itemId) ? 'downloads.remove_from_device' : 'downloads.download', 'download', () => this.toggleDownload(t))]
        : []),
      ...(this.party.active()
        ? [own('karaoke.queue_sing_this', 'mic', () => this.sing(t), !t.hasFile, { title: t.title })]
        : []),
      ...(this.creditGroups(t).length ? [own('music.credits', 'users', () => this.openCredits(t))] : []),
      ...this.trackActions.rows().map((r) => toCardAction(r)),
    ];
    this.cardActions.register({ actions, anchor, placement: 'button', title: t.title, subtitle: this.artistsText(), imageUrl: this.coverUrl(), imageAspect: 'square' });
    this.cardActions.show();
  }

  protected sing(t: Track): void {
    void this.party.proposeTrack(this.media().id, t.itemId);
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
