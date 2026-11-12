import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { LucideChevronLeft } from '@lucide/angular';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { TranslatePipe } from '@ngx-translate/core';
import { MusicApiService } from '../../core/services/api/music-api.service';
import type { Discography } from '../../core/services/api/music.models';
import { FollowToggleComponent } from '../../shared/components/follow-toggle/follow-toggle';
import { MediaCardComponent } from '../../shared/components/media-card/media-card';
import { MediaGridComponent } from '../../shared/components/media-grid/media-grid';
import { MusicDownloadButtonComponent } from '../../shared/components/music-download-button/music-download-button';
import { MusicDownloadsService } from '../../core/services/music-downloads.service';
import { NavbarService } from '../../core/services/navbar.service';
import { CardSkeletonComponent } from '../../shared/components/card-skeleton';
import { PersonHeaderComponent } from '../../shared/components/person-header/person-header';
import { groupDiscography } from './music-utils';

/** What a person card hands its page (`person-avatar-card`'s `state`). */
export interface HandedPerson {
  id: number;
  name: string;
  avatarUrl: string | null;
}

/** An artist: biography, follow, and the discography by release type with the albums not in the library apart. */
@Component({
  selector: 'app-artist-page',
  imports: [TranslatePipe, LucideChevronLeft, CardSkeletonComponent, FollowToggleComponent, MusicDownloadButtonComponent, MediaCardComponent, MediaGridComponent, PersonHeaderComponent],
  templateUrl: './artist-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ArtistPageComponent {
  private readonly api = inject(MusicApiService);
  private readonly downloads = inject(MusicDownloadsService);
  private readonly navbar = inject(NavbarService);
  private readonly router = inject(Router);
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
  protected readonly groups = computed(() => groupDiscography(this.data()?.albums ?? []));
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
