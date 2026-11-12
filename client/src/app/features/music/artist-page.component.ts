import { DestroyRef, ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { LucideChevronLeft, LucideMusic } from '@lucide/angular';
import { NgTemplateOutlet } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { TranslatePipe } from '@ngx-translate/core';
import { MusicApiService } from '../../core/services/api/music-api.service';
import type { Discography, PopularTrack } from '../../core/services/api/music.models';
import { AudioPlayerService } from '../../core/services/audio-player/audio-player.service';
import { AuthService } from '../../core/services/auth.service';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { AddDialogComponent } from '../../shared/components/add-dialog/add-dialog';
import { CachedSrcDirective } from '../../shared/directives/cached-src.directive';
import { FollowToggleComponent } from '../../shared/components/follow-toggle/follow-toggle';
import { MediaCardComponent } from '../../shared/components/media-card/media-card';
import { MediaGridComponent } from '../../shared/components/media-grid/media-grid';
import { MusicDownloadButtonComponent } from '../../shared/components/music-download-button/music-download-button';
import { MusicDownloadsService } from '../../core/services/music-downloads.service';
import { NavbarService } from '../../core/services/navbar.service';
import { CardSkeletonComponent } from '../../shared/components/card-skeleton';
import { PersonHeaderComponent } from '../../shared/components/person-header/person-header';
import { TrackLineComponent } from './track-line.component';
import { DISCOGRAPHY_TABS, type DiscographyTab, discographyTabs, trackRowRequest } from './music-utils';

/** What a person card hands its page (`person-avatar-card`'s `state`). */
export interface HandedPerson {
  id: number;
  name: string;
  avatarUrl: string | null;
}

/** An artist: biography, follow, the most listened tracks, and the discography by release type, owned and missing albums together. */
@Component({
  selector: 'app-artist-page',
  imports: [NgTemplateOutlet, TranslatePipe, LucideChevronLeft, LucideMusic, ResolveUrlPipe, CachedSrcDirective, AddDialogComponent, TrackLineComponent, CardSkeletonComponent, FollowToggleComponent, MusicDownloadButtonComponent, MediaCardComponent, MediaGridComponent, PersonHeaderComponent],
  templateUrl: './artist-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ArtistPageComponent {
  private readonly api = inject(MusicApiService);
  private readonly downloads = inject(MusicDownloadsService);
  private readonly navbar = inject(NavbarService);
  private readonly router = inject(Router);
  private readonly player = inject(AudioPlayerService);
  private readonly auth = inject(AuthService);
  private readonly addDialog = viewChild(AddDialogComponent);
  protected readonly id = toSignal(inject(ActivatedRoute).paramMap.pipe(map((p) => Number(p.get('id')))), { initialValue: 0 });
  protected readonly data = signal<Discography | null>(null);
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);
  /** The card's name and avatar, handed over router state so the header is there when the transition captures. */
  private readonly handed: HandedPerson | null =
    (this.router.getCurrentNavigation()?.extras.state ?? history.state)?.person ?? null;
  protected readonly head = computed(() => {
    const d = this.data();
    if (d?.artist.id === this.id()) return { name: d.artist.name, avatarUrl: d.artist.imageUrl, biography: d.artist.biography };
    const h = this.handed;
    return h?.id === this.id() ? { name: h.name, avatarUrl: h.avatarUrl, biography: null } : null;
  });
  protected readonly skeletonCards = Array.from({ length: 12 }, (_, i) => i);
  protected readonly tabs = computed(() => discographyTabs(this.data()?.albums ?? [], this.data()?.popular ?? []));
  protected readonly filled = computed(() => DISCOGRAPHY_TABS.filter((t) => this.tabs()[t].length));
  private readonly picked = signal<DiscographyTab | null>(null);
  protected readonly tab = computed(() => {
    const p = this.picked();
    return p && this.filled().includes(p) ? p : (this.filled()[0] ?? null);
  });
  protected readonly albums = computed(() => (this.tab() ? this.tabs()[this.tab()!] : []));
  protected readonly popularShown = signal(5);
  protected readonly popular = computed(() => (this.data()?.popular ?? []).slice(0, this.popularShown()));
  protected readonly popularSkeleton = [0, 1, 2, 3, 4];
  protected readonly canAdd = computed(() => this.auth.hasPermission('media.create'));
  protected readonly subtitle = computed(() => {
    const a = this.data()?.artist;
    return [a?.artistType, a?.disambiguation].filter(Boolean).join(' · ');
  });

  /** The tracks of the artist's albums that are in the library. */
  protected readonly tracks = () =>
    this.downloads.albumsTracks((this.data()?.albums ?? []).flatMap((a) => (a.mediaId == null ? [] : [a.mediaId])));

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => void this.load(id));
    });
    effect(() => {
      const name = this.data()?.artist.name;
      if (name) this.navbar.setPageTitle(name);
    });
    inject(DestroyRef).onDestroy(() => this.navbar.clearPageTitle());
  }

  protected pick(t: DiscographyTab): void {
    this.picked.set(t);
  }

  /** Plays the owned popular tracks from the tapped one. */
  protected play(row: PopularTrack): void {
    const owned = (this.data()?.popular ?? []).flatMap((p) => (p.track?.hasFile ? [p.track] : []));
    const start = Math.max(0, owned.findIndex((t) => t.itemId === row.track?.itemId));
    void this.player.playTracks(owned.map(trackRowRequest), start);
  }

  protected want(row: PopularTrack): void {
    if (!row.albumExternalId) return;
    void this.addDialog()?.add({
      kind: 'album',
      provider: 'musicbrainz',
      externalId: row.albumExternalId,
      title: row.albumTitle ?? row.title,
      recording: { externalId: row.recordingId, albumExternalId: row.albumExternalId },
      mode: this.canAdd() ? 'import' : 'request',
    });
  }

  protected goBack(): void {
    this.navbar.goBack(['/']);
  }

  protected retry(): void {
    void this.load(this.id());
  }

  private async load(id: number): Promise<void> {
    this.loading.set(true);
    this.failed.set(false);
    try {
      const d = await this.api.discography(id);
      if (id === this.id()) this.data.set(d);
    } catch {
      if (id === this.id()) this.failed.set(true);
    } finally {
      if (id === this.id()) this.loading.set(false);
    }
  }
}
