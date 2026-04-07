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
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { PersonsApiService, Person } from '../../core/services/api/persons-api.service';
import { ScrollMemoryService } from '../../core/services/scroll-memory.service';
import { InfiniteScrollList } from '../../shared/utils/infinite-scroll-list';
import { LucideSearch, LucideUsers } from '@lucide/angular';

const ALPHABET = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

@Component({
  selector: 'app-persons',
  imports: [FormsModule, TranslateModule, RouterLink, LucideSearch, LucideUsers],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './persons.html',
})
export class PersonsComponent implements OnInit, OnDestroy {
  private readonly personsApi = inject(PersonsApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly scrollMemory = inject(ScrollMemoryService);
  private readonly injector = inject(Injector);
  private readonly scrollKey = 'persons';

  readonly list = new InfiniteScrollList<Person>();
  readonly loading = signal(false);
  readonly searchQuery = signal('');
  readonly filterRole = signal('');
  readonly alphabet = ALPHABET;
  readonly activeLetter = signal('');

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
    this.activeLetter.set(letter);
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

  private async load() {
    this.loading.set(true);
    try {
      const results = await this.personsApi.search(this.searchQuery());
      results.sort((a, b) => a.name.localeCompare(b.name));
      this.allResults = results;
      this.applyFilter();
    } finally {
      this.loading.set(false);
    }
  }

  private applyFilter() {
    const role = this.filterRole();
    const filtered = role
      ? this.allResults.filter((p) => p.departments?.includes(role))
      : this.allResults;
    this.list.setItems(filtered);
  }
}
