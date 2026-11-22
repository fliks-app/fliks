import { Component, DestroyRef, ElementRef, effect, inject, input, Signal, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import {
  CdkVirtualScrollViewport,
  CdkFixedSizeVirtualScroll,
  CdkVirtualForOf,
} from '@angular/cdk/scrolling';
import { TranslatePluralPipe } from '../../core/pipes/translate-plural.pipe';
import { MusicApiService } from '../../core/services/api/music-api.service';
import type { MusicPersonRow } from '../../core/services/api/music.models';
import { PersonAvatarCardComponent } from '../../shared/components/person-avatar-card/person-avatar-card';
import { VirtualGrid } from '../../shared/utils/infinite-scroll-list';
import { PageScrollWindowDirective } from '../../shared/directives/page-scroll-window.directive';
import { PagedList } from './paged-list';
import { RowSkeletonComponent } from '../../shared/components/row-skeleton/row-skeleton';

const PAGE = 60;

/** The artists or the composers of a library, as a grid of avatars. */
@Component({
  selector: 'app-music-people',
  imports: [RowSkeletonComponent, 
    FormsModule,
    TranslatePipe,
    TranslatePluralPipe,
    PersonAvatarCardComponent,
    CdkVirtualScrollViewport,
    CdkFixedSizeVirtualScroll,
    CdkVirtualForOf,
    PageScrollWindowDirective,
  ],
  templateUrl: './music-people.component.html',
  host: { class: 'block' },
})
export class MusicPeopleComponent {
  readonly role = input.required<'artist' | 'composer'>();
  readonly libraryId = input<number | undefined>(undefined);
  /** The hosting page's `keepRouteFresh` signal. */
  readonly detached = input.required<Signal<boolean>>();

  private readonly api = inject(MusicApiService);
  protected readonly query = signal('');
  protected readonly list = new PagedList<MusicPersonRow>(
    (page) => this.api.people(this.role(), { libraryId: this.libraryId(), q: this.query() || undefined, page, limit: PAGE }),
    PAGE,
  );
  protected readonly grid = new VirtualGrid<MusicPersonRow>(() => this.list.rows());
  private readonly firstRow = viewChild<ElementRef<HTMLElement>>('personRow');

  constructor() {
    effect((onCleanup) => {
      this.role();
      this.libraryId();
      const q = this.query();
      const t = setTimeout(() => untracked(() => void this.list.load()), q ? 300 : 0);
      onCleanup(() => clearTimeout(t));
    });
    effect(() => {
      const row = this.firstRow()?.nativeElement;
      untracked(() => this.grid.bindRow(row));
    });
    // A resize can change the column count, which re-chunks the rows.
    const onResize = () => this.grid.measure();
    window.addEventListener('resize', onResize, { passive: true });
    inject(DestroyRef).onDestroy(() => window.removeEventListener('resize', onResize));
  }

  protected link(p: MusicPersonRow): string[] {
    return [this.role() === 'artist' ? '/artists' : '/composers', String(p.id)];
  }
}
