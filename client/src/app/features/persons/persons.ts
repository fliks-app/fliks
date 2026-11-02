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
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TvSelectDirective } from '../../shared/directives/tv-select.directive';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { PersonsApiService, Person } from '../../core/services/api/persons-api.service';
import { BooksApiService } from '../../core/services/api/books-api.service';
import { ScrollMemoryService } from '../../core/services/scroll-memory.service';
import { keepRouteFresh } from '../../core/services/keep-route-fresh';
import { InfiniteScrollList } from '../../shared/utils/infinite-scroll-list';
import { LucideSearch, LucideUsers } from '@lucide/angular';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { CachedSrcDirective } from '../../shared/directives/cached-src.directive';

const ALPHABET = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

@Component({
  selector: 'app-persons',
  imports: [TvSelectDirective, 
    CachedSrcDirective,FormsModule, TranslatePipe, RouterLink, ResolveUrlPipe, LucideSearch, LucideUsers],
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
  private readonly routeFresh = keepRouteFresh({
    refresh: () => void this.load(true),
    scrollKey: this.scrollKey,
  });

  readonly list = new InfiniteScrollList<Person>();
  readonly loading = signal(false);
  readonly searchQuery = signal('');
  readonly filterRole = signal('');
  readonly alphabet = ALPHABET;
  /** `?role=author|narrator` lists the book people of the library instead of the cast and crew. */
  readonly bookRole = (['author', 'narrator'] as const).find(
    (r) => r === this.route.snapshot.queryParamMap.get('role'),
  );
  readonly workCounts = new Map<number, number>();

  private allResults: Person[] = [];

  private readonly storageKey = 'fliks.filters.persons';

  @ViewChild('sentinel') set sentinelRef(ref: ElementRef<HTMLElement> | undefined) {
    this.list.observeSentinel(ref);
  }

  ngOnInit() {
    const qp = this.route.snapshot.queryParamMap;
    const stored = this.loadFilters();
    this.searchQuery.set(qp.get('q') ?? stored['q'] ?? '');

    this.scrollMemory.activate(this.scrollKey);
    this.list.trackScroll('person');
    this.syncQueryParams();
    this.load().then(() =>
      this.scrollMemory.restore(this.scrollKey, this.injector),
    );

  }

  ngOnDestroy() {
    this.scrollMemory.deactivate();
    this.list.destroy();
  }

  scrollToLetter(letter: string) {
    this.list.scrollToLetter(letter, (p) => p.name, 'person');
  }

  onSearch(query: string) {
    this.searchQuery.set(query);
    this.syncQueryParams();
    this.load();
  }

  onFilterRole(role: string) {
    this.filterRole.set(role);
    this.applyFilter();
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
    if (!silent) this.loading.set(true);
    try {
      const results = this.bookRole ? await this.loadBookPeople(this.bookRole) : await this.personsApi.search(this.searchQuery());
      results.sort((a, b) => a.name.localeCompare(b.name));
      this.allResults = results;
      this.applyFilter();
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

  private applyFilter() {
    const role = this.filterRole();
    const filtered = role
      ? this.allResults.filter((p) => p.departments?.includes(role))
      : this.allResults;
    this.list.setItems(filtered, (p) => p.name);
  }
}
