import { Component, OnInit, OnDestroy, inject, signal, computed, effect, viewChild, ElementRef } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { LiveTvApiService, OnNowEntry, OnNowPage } from '../../core/services/api/livetv-api.service';
import { AuthService } from '../../core/services/auth.service';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { CachedSrcDirective } from '../../shared/directives/cached-src.directive';
import { TvSectionDirective } from '../../shared/directives/tv-section.directive';
import { TvRowDirective } from '../../shared/directives/tv-row.directive';
import { DefaultFocusDirective } from '../../shared/directives/default-focus.directive';
import { LiveTvGuideComponent } from './guide/guide';
import { LucideStar, LucideSearch, LucideTv } from '@lucide/angular';
import { TvSelectDirective } from '../../shared/directives/tv-select.directive';
import { programmeProgressPercent } from './programme-progress';

interface OnNowGroup {
  groupName: string;
  items: OnNowEntry[];
}

/** Cards per fetch, matching the endpoint's own page-size cap. */
const PAGE_SIZE = 50;
/** Same debounce as the free-text search field elsewhere (search.ts). */
const QUERY_DEBOUNCE_MS = 350;

@Component({
  selector: 'app-live-tv',
  imports: [TvSelectDirective, 
    NgTemplateOutlet,
    RouterLink,
    FormsModule,
    TranslatePipe,
    ResolveUrlPipe,
    CachedSrcDirective,
    TvSectionDirective,
    TvRowDirective,
    DefaultFocusDirective,
    LiveTvGuideComponent,
    LucideStar,
    LucideSearch,
    LucideTv,
  ],
  templateUrl: './live-tv.html',
})
export class LiveTvComponent implements OnInit, OnDestroy {
  private readonly api = inject(LiveTvApiService);
  private readonly router = inject(Router);
  readonly auth = inject(AuthService);

  private readonly sentinel = viewChild<ElementRef<HTMLElement>>('sentinel');
  private observer?: IntersectionObserver;
  private loadSeq = 0;
  private queryDebounce: ReturnType<typeof setTimeout> | null = null;

  readonly tab = signal<'on-now' | 'guide'>('on-now');
  readonly loading = signal(true);
  readonly loadingMore = signal(false);
  readonly loadError = signal(false);
  readonly entries = signal<OnNowEntry[]>([]);
  readonly page = signal(1);
  readonly total = signal(0);
  readonly query = signal('');
  readonly groupFilter = signal('');
  readonly groups = signal<string[]>([]);

  readonly hasMore = computed(() => this.entries().length < this.total());

  readonly favoriteEntries = computed(() => this.entries().filter((e) => e.channel.favorite));

  readonly groupedEntries = computed<OnNowGroup[]>(() => {
    const rest = this.entries().filter((e) => !e.channel.favorite);
    const map = new Map<string, OnNowEntry[]>();
    for (const e of rest) {
      const key = e.channel.groupName ?? '';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(e);
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([groupName, items]) => ({ groupName, items }));
  });

  readonly isEmpty = computed(
    () => !this.loading() && !this.loadError() && this.entries().length === 0,
  );

  readonly failedLogos = signal<ReadonlySet<number>>(new Set());

  onLogoError(channelId: number): void {
    this.failedLogos.update((s) => new Set(s).add(channelId));
  }

  showLogo(entry: OnNowEntry): boolean {
    return !!entry.channel.logoPath && !this.failedLogos().has(entry.channel.id);
  }

  ngOnInit(): void {
    void this.loadGroups();
    void this.load(true);
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
    if (this.queryDebounce) clearTimeout(this.queryDebounce);
  }

  private readonly bindSentinel = effect(() => {
    const el = this.sentinel()?.nativeElement;
    this.observer?.disconnect();
    if (!el) return;
    this.observer = new IntersectionObserver(
      (observed) => {
        if (observed[0]?.isIntersecting) void this.load(false);
      },
      { rootMargin: '600px' },
    );
    this.observer.observe(el);
  });

  private async loadGroups(): Promise<void> {
    try {
      const channels = await this.api.getChannels();
      const set = new Set<string>();
      for (const c of channels) if (c.groupName) set.add(c.groupName);
      this.groups.set([...set].sort());
    } catch {
      // filter dropdown stays empty; not fatal
    }
  }

  onQueryInput(value: string): void {
    this.query.set(value);
    if (this.queryDebounce) clearTimeout(this.queryDebounce);
    this.queryDebounce = setTimeout(() => void this.load(true), QUERY_DEBOUNCE_MS);
  }

  onGroupChange(value: string): void {
    this.groupFilter.set(value);
    void this.load(true);
  }

  async load(reset: boolean): Promise<void> {
    if (reset) {
      this.page.set(1);
      this.entries.set([]);
      this.total.set(0);
      this.loadingMore.set(false); // a reset supersedes any pagination fetch in flight
    } else if (!this.hasMore() || this.loadingMore() || this.loading()) {
      return;
    }
    const seq = ++this.loadSeq;
    const requestedPage = reset ? 1 : this.page() + 1;
    (reset ? this.loading : this.loadingMore).set(true);
    try {
      const res = await this.api.getOnNow({
        page: requestedPage,
        pageSize: PAGE_SIZE,
        query: this.query().trim() || undefined,
        group: this.groupFilter() || undefined,
      });
      if (seq !== this.loadSeq) return;
      if (!reset) this.page.set(requestedPage);
      this.applyPage(res, reset);
      this.loadError.set(false);
    } catch {
      if (seq === this.loadSeq) this.loadError.set(true);
    } finally {
      if (seq === this.loadSeq) (reset ? this.loading : this.loadingMore).set(false);
    }
  }

  private applyPage(res: OnNowPage, reset: boolean): void {
    this.total.set(res.total);
    this.entries.update((cur) => (reset ? res.entries : [...cur, ...res.entries]));
  }

  async toggleFavorite(entry: OnNowEntry, event: Event): Promise<void> {
    event.stopPropagation();
    const next = !entry.channel.favorite;
    this.applyFavorite(entry.channel.id, next);
    try {
      await this.api.setPrefs(entry.channel.id, { favorite: next });
    } catch {
      this.applyFavorite(entry.channel.id, !next);
    }
  }

  private applyFavorite(channelId: number, favorite: boolean): void {
    this.entries.update((list) =>
      list.map((e) => (e.channel.id === channelId ? { ...e, channel: { ...e.channel, favorite } } : e)),
    );
  }

  watch(entry: OnNowEntry): void {
    void this.router.navigate(['/watch-live', entry.channel.id]);
  }

  readonly progressPercent = programmeProgressPercent;

  initials(name: string): string {
    return name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase();
  }
}
