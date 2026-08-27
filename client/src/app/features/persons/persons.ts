import {
  Component,
  ChangeDetectionStrategy,
  signal,
  inject,
  Injector,
  OnInit,
  OnDestroy,
  ElementRef,
  ViewChild,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { PersonsApiService, Person } from '../../core/services/api/persons-api.service';
import { ScrollMemoryService } from '../../core/services/scroll-memory.service';
import { CachingReuseStrategy } from '../../core/services/route-reuse.strategy';
import { InfiniteScrollList } from '../../shared/utils/infinite-scroll-list';
import { LucideSearch, LucideUsers } from '@lucide/angular';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { CachedSrcDirective } from '../../shared/directives/cached-src.directive';

const ALPHABET = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

@Component({
  selector: 'app-persons',
  imports: [
    CachedSrcDirective,FormsModule, TranslateModule, RouterLink, ResolveUrlPipe, LucideSearch, LucideUsers],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './persons.html',
})
export class PersonsComponent implements OnInit, OnDestroy {
  private readonly personsApi = inject(PersonsApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly scrollMemory = inject(ScrollMemoryService);
  private readonly reuseStrategy = inject(CachingReuseStrategy);
  private readonly injector = inject(Injector);
  private readonly scrollKey = 'persons';
  private attachedSub?: Subscription;
  private detachedSub?: Subscription;

  readonly list = new InfiniteScrollList<Person>();
  readonly loading = signal(false);
  readonly searchQuery = signal('');
  readonly filterRole = signal('');
  readonly alphabet = ALPHABET;

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

    // Route is cached on navigate-away (data: { reuse: true }). On return,
    // ngOnInit doesn't fire — refresh via attached$ instead, keeping stale
    // results visible during the silent revalidation.
    const ownKey = this.reuseStrategy.keyFor(this.route.snapshot);
    this.attachedSub = this.reuseStrategy.attached$.subscribe((key) => {
      if (key !== ownKey) return;
      this.scrollMemory.activate(this.scrollKey);
      void this.load(true);
      this.scrollMemory.restoreSticky(this.scrollKey);
    });
    this.detachedSub = this.reuseStrategy.detached$.subscribe((key) => {
      if (key === ownKey) this.scrollMemory.deactivateIf(this.scrollKey);
    });
  }

  ngOnDestroy() {
    this.scrollMemory.deactivate();
    this.list.destroy();
    this.attachedSub?.unsubscribe();
    this.detachedSub?.unsubscribe();
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
      const results = await this.personsApi.search(this.searchQuery());
      results.sort((a, b) => a.name.localeCompare(b.name));
      this.allResults = results;
      this.applyFilter();
    } finally {
      if (!silent) this.loading.set(false);
    }
  }

  private applyFilter() {
    const role = this.filterRole();
    const filtered = role
      ? this.allResults.filter((p) => p.departments?.includes(role))
      : this.allResults;
    this.list.setItems(filtered, (p) => p.name);
  }
}
