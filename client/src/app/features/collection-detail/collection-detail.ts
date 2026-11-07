import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { AuthService } from '../../core/services/auth.service';
import { OptimizeModalService } from '../../core/services/optimize-modal.service';
import { BooksApiService } from '../../core/services/api/books-api.service';
import { NavbarService } from '../../core/services/navbar.service';
import type { CollectionDetail } from '../../core/services/api/books.models';
import { KIND_REGISTRY, mediaDetailLink } from '../../core/media-kinds';
import { FollowToggleComponent } from '../../shared/components/follow-toggle/follow-toggle';
import { MediaCardComponent } from '../../shared/components/media-card/media-card';

type Entry = CollectionDetail['entries'][number];
export type Tile =
  | { kind: 'entry'; position: number | null; entry: Entry }
  | { kind: 'missing'; position: number };

@Component({
  selector: 'app-collection-detail',
  imports: [TranslatePipe, RouterLink, MediaCardComponent, FollowToggleComponent],
  templateUrl: './collection-detail.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CollectionDetailComponent {
  private readonly api = inject(BooksApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly auth = inject(AuthService);
  private readonly optimizeModal = inject(OptimizeModalService);

  readonly detail = signal<CollectionDetail | null>(null);
  readonly loading = signal(true);

  /** Entries and missing positions in position order, unpositioned entries last. */
  readonly tiles = computed<Tile[]>(() => {
    const d = this.detail();
    if (!d) return [];
    const all: Tile[] = [
      ...d.entries.map((entry): Tile => ({ kind: 'entry', position: entry.position, entry })),
      ...d.missingPositions.map((position): Tile => ({ kind: 'missing', position })),
    ];
    return all.sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));
  });

  /** A series of books can be watched for new volumes. */
  readonly isBookSeries = computed(() => this.detail()?.entries.some((e) => e.media.type === 'book') ?? false);

  private readonly videoIds = computed(
    () =>
      this.detail()?.entries
        .filter((e) => KIND_REGISTRY[e.media.type].families.includes('video'))
        .map((e) => e.media.id) ?? [],
  );

  readonly canOptimize = computed(() => this.auth.hasPermission('settings.access') && this.videoIds().length > 0);

  optimize() {
    const d = this.detail();
    if (d) this.optimizeModal.open({ title: d.name, mediaIds: this.videoIds() });
  }

  readonly nextUp = computed(() => {
    const d = this.detail();
    const media = d?.entries.find((e) => e.media.id === d.nextUp)?.media;
    return media ? mediaDetailLink(media.type, media.id) : null;
  });

  constructor() {
    void this.load(Number(this.route.snapshot.paramMap.get('id')));
    const navbar = inject(NavbarService);
    navbar.showBackButton.set(true);
    inject(DestroyRef).onDestroy(() => navbar.showBackButton.set(false));
  }

  link(e: Entry) {
    return mediaDetailLink(e.media.type, e.media.id);
  }

  private async load(id: number) {
    try {
      this.detail.set(await this.api.collection(id));
    } finally {
      this.loading.set(false);
    }
  }
}
