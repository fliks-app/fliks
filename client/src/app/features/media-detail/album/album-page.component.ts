import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, linkedSignal, signal, viewChild } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideEllipsisVertical, LucideHeart, LucideListEnd, LucideListPlus, LucideListStart, LucideMic, LucidePlay, LucideShuffle, LucideUsers } from '@lucide/angular';
import { TranslatePluralPipe } from '../../../core/pipes/translate-plural.pipe';
import { AddToPlaylistService } from '../../../core/services/add-to-playlist.service';
import { AudioPlayerService } from '../../../core/services/audio-player/audio-player.service';
import { LikesApiService } from '../../../core/services/api/likes-api.service';
import type { Media } from '../../../core/services/api/media.service';
import { MusicApiService } from '../../../core/services/api/music-api.service';
import type { AlbumCandidate, AlbumEdition, Track } from '../../../core/services/api/music.models';
import { PartyService } from '../../../core/services/party/party.service';
import { IdentifyModalService } from '../../../core/services/identify-modal.service';
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
import { DropdownMenuComponent } from '../../../shared/components/dropdown-menu';
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
    DropdownMenuComponent, ModalHeaderComponent,
    LucideEllipsisVertical, LucideHeart, LucideListEnd, LucideListPlus, LucideListStart, LucideMic, LucidePlay, LucideShuffle, LucideUsers,
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
  private readonly player = inject(AudioPlayerService);
  private readonly playlists = inject(AddToPlaylistService);
  private readonly identifyModal = inject(IdentifyModalService);
  protected readonly party = inject(PartyService);
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
  protected readonly discs = computed<DiscView[]>(() =>
    groupDiscs(this.tracks()).map((disc) => ({ disc, sections: groupByWork(disc.tracks) })),
  );
  protected readonly playable = computed(() => this.tracks().filter((t) => t.hasFile));
  protected readonly orphaned = computed(() => !!this.album()?.orphaned || !!this.edition()?.orphaned);
  protected readonly desktop = heroDesktopLayout();
  /** Identify lists the releases the files may be, instead of the title search of the other kinds. */
  protected readonly actions: MediaActionHandlers = { 'media.identify': () => void this.review() };
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

  protected play(startItemId?: number, shuffle = false): Promise<void> {
    const list = this.playable();
    const start = startItemId == null ? 0 : Math.max(0, list.findIndex((t) => t.itemId === startItemId));
    return this.player.playTracks(list.map((t) => this.request(t)), start, shuffle ? { shuffle: true } : undefined);
  }

  protected addToPlaylist(t: Track): void {
    this.playlists.open({ itemId: t.itemId });
  }

  protected sing(t: Track): void {
    void this.party.proposeTrack(this.media().id, t.itemId);
  }

  protected enqueue(t: Track, where: 'next' | 'last'): void {
    this.player.enqueueTracks([this.request(t)], where);
  }

  protected readonly creditsOf = signal<Track | null>(null);
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
