import {
  Component,
  signal,
  inject,
  Injector,
  OnInit,
  OnDestroy,
  ElementRef,
  ViewChild,
} from '@angular/core';
import {
  CdkVirtualScrollViewport,
  CdkFixedSizeVirtualScroll,
  CdkVirtualForOf,
} from '@angular/cdk/scrolling';
import { ActivatedRoute, Router } from '@angular/router';
import { TvSelectDirective } from '../../shared/directives/tv-select.directive';
import { PageScrollWindowDirective } from '../../shared/directives/page-scroll-window.directive';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { PersonsApiService, Person } from '../../core/services/api/persons-api.service';
import { BooksApiService } from '../../core/services/api/books-api.service';
import { ScrollMemoryService } from '../../core/services/scroll-memory.service';
import { keepRouteFresh } from '../../core/services/keep-route-fresh';
import { InfiniteScrollList } from '../../shared/utils/infinite-scroll-list';
import { PagedList } from '../music/paged-list';
import { LucideSearch } from '@lucide/angular';
import { TranslatePluralPipe } from '../../core/pipes/translate-plural.pipe';
import { PersonAvatarCardComponent } from '../../shared/components/person-avatar-card/person-avatar-card';
import { RowSkeletonComponent } from '../../shared/components/row-skeleton/row-skeleton';
import { EmptyStateComponent } from '../../shared/components/empty-state/empty-state';

const ALPHABET = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const PAGE = 50;

@Component({
  selector: 'app-persons',
  imports: [EmptyStateComponent, RowSkeletonComponent,
    TranslatePluralPipe,
    TvSelectDirective,
    FormsModule,
    TranslatePipe,
    PersonAvatarCardComponent,
    LucideSearch,
    CdkVirtualScrollViewport,
    CdkFixedSizeVirtualScroll,
    CdkVirtualForOf,
    PageScrollWindowDirective,
  ],
  templateUrl: './persons.html',
})
export class PersonsComponent implements OnInit, OnDestroy {
  private readonly personsApi = inject(PersonsApiService);
  private readonly booksApi = inject(BooksApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly scrollMemory = inject(ScrollMemoryService);

  private readonly injector = inject(Injector);
  private readonly scrollKey = 'persons';
  /** Cached route: revalidate on return, keeping the listed people on screen
   *  while the request goes out. */
  protected readonly detached = keepRouteFresh({
    refresh: () => void this.load(true),
    scrollKey: this.scrollKey,
  });

  readonly list = new InfiniteScrollList<Person>();
  readonly loading = signal(false);
  readonly searchQuery = signal('');
  readonly filterRole = signal('');
  /** The initial the cast and crew list is narrowed to, '' for all. */
  readonly letter = signal('');
  readonly alphabet = ALPHABET;
  /** `?role=author|narrator` lists the book people of the library instead of the cast and crew. */
  readonly bookRole = (['author', 'narrator'] as const).find(
    (r) => r === this.route.snapshot.queryParamMap.get('role'),
  );
  readonly workCounts = new Map<number, number>();

  /** The cast and crew pages; the server applies `letter` and the role before cutting a page. */
  readonly paged = new PagedList<Person>(
    (page) =>
      this.personsApi.search(this.searchQuery(), undefined, {
        page,
        limit: PAGE,
        letter: this.letter() || undefined,
        department: this.filterRole() || undefined,
      }),
    PAGE,
  );

  private readonly storageKey = 'fliks.filters.persons';

  @ViewChild(CdkVirtualScrollViewport) set viewportRef(ref: CdkVirtualScrollViewport | undefined) {
    this.list.bindViewport(ref);
  }

  @ViewChild('personRow') set personRowRef(ref: ElementRef<HTMLElement> | undefined) {
    this.list.grid.bindRow(ref?.nativeElement);
  }

  /** A resize can change the column count, which re-chunks the rows. */
  private readonly onResize = () => this.list.grid.measure();

  ngOnInit() {
    const qp = this.route.snapshot.queryParamMap;
    const stored = this.loadFilters();
    this.searchQuery.set(qp.get('q') ?? stored['q'] ?? '');

    this.scrollMemory.activate(this.scrollKey);
    this.list.trackScroll();
    window.addEventListener('resize', this.onResize, { passive: true });
    this.syncQueryParams();
    this.load().then(() =>
      this.scrollMemory.restore(this.scrollKey, this.injector),
    );

  }

  ngOnDestroy() {
    this.scrollMemory.deactivateIf(this.scrollKey);
    this.list.destroy();
    window.removeEventListener('resize', this.onResize);
  }

  /** Book people are all loaded, so a letter scrolls; cast and crew are paged, so a letter filters. */
  scrollToLetter(letter: string) {
    if (this.bookRole) return this.list.scrollToLetter(letter, (p) => p.name);
    this.letter.set(this.letter() === letter ? '' : letter);
    void this.load();
  }

  letterEnabled(letter: string): boolean {
    return !this.bookRole || this.list.availableLetters().has(letter);
  }

  letterActive(letter: string): boolean {
    return (this.bookRole ? this.list.activeLetter() : this.letter()) === letter;
  }

  loadMore() {
    void this.paged.loadMore().then(() => this.list.setItems(this.paged.rows(), (p) => p.name));
  }

  onSearch(query: string) {
    this.searchQuery.set(query);
    this.syncQueryParams();
    this.load();
  }

  onFilterRole(role: string) {
    this.filterRole.set(role);
    void this.load();
  }

  private syncQueryParams() {
    const params: Record<string, string> = {};
    if (this.bookRole) params['role'] = this.bookRole;
    if (this.searchQuery()) params['q'] = this.searchQuery();
    void this.router.navigate([], { queryParams: params, replaceUrl: true });
    this.saveFilters();
  }

  private saveFilters() {
    const data: Record<string, string> = {};
    if (this.searchQuery()) data['q'] = this.searchQuery();
    localStorage.setItem(this.storageKey, JSON.stringify(data));
  }

  private loadFilters(): Record<string, string> {
    try {
      return JSON.parse(localStorage.getItem(this.storageKey) ?? '{}');
    } catch {
      return {};
    }
  }

  private async load(silent = false) {
    // A refresh would drop the pages already loaded.
    if (silent && !this.bookRole && this.paged.rows().length > PAGE) return;
    if (!silent) this.loading.set(true);
    try {
      if (this.bookRole) {
        const results = await this.loadBookPeople(this.bookRole);
        this.list.setItems([...results].sort((a, b) => a.name.localeCompare(b.name)), (p) => p.name);
      } else {
        await this.paged.load();
        this.list.setItems(this.paged.rows(), (p) => p.name);
      }
    } finally {
      if (!silent) this.loading.set(false);
    }
  }

  private async loadBookPeople(role: 'author' | 'narrator'): Promise<Person[]> {
    const params: Record<string, string> = { role };
    if (this.searchQuery()) params['q'] = this.searchQuery();
    const items = await this.booksApi.persons(params);
    items.forEach((i) => this.workCounts.set(i.id, i.workCount));
    return items.map((i) => ({
      id: i.id, tmdbId: null, name: i.name, avatarUrl: i.avatarUrl, biography: null, birthday: null,
      deathday: null, placeOfBirth: null, knownForDepartment: null, departments: [], metadataRefreshedAt: null,
    }));
  }
}
