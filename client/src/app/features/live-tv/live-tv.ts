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
  private loadingAll = false;

  readonly tab = signal<'on-now' | 'guide'>('on-now');
  readonly loading = signal(true);
  readonly loadingMore = signal(false);
  readonly entries = signal<OnNowEntry[]>([]);
  readonly page = signal(1);
  readonly total = signal(0);
  readonly query = signal('');
  readonly groupFilter = signal('');

  readonly hasMore = computed(() => this.entries().length < this.total());

  readonly groups = computed(() => {
    const set = new Set<string>();
    for (const e of this.entries()) if (e.channel.groupName) set.add(e.channel.groupName);
    return [...set].sort();
  });

  private readonly filteredEntries = computed(() => {
    const q = this.query().trim().toLowerCase();
    const group = this.groupFilter();
    return this.entries().filter((e) => {
      if (group && e.channel.groupName !== group) return false;
      if (q && !e.channel.name.toLowerCase().includes(q)) return false;
      return true;
    });
  });

  readonly favoriteEntries = computed(() => this.filteredEntries().filter((e) => e.channel.favorite));

  readonly groupedEntries = computed<OnNowGroup[]>(() => {
    const rest = this.filteredEntries().filter((e) => !e.channel.favorite);
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

  readonly isEmpty = computed(() => !this.loading() && this.entries().length === 0);

  readonly failedLogos = signal<ReadonlySet<number>>(new Set());

  onLogoError(channelId: number): void {
    this.failedLogos.update((s) => new Set(s).add(channelId));
  }

  showLogo(entry: OnNowEntry): boolean {
    return !!entry.channel.logoPath && !this.failedLogos().has(entry.channel.id);
  }

  /** A typed search or a picked group only ever matches loaded cards, so a
   *  filter in play pulls in the rest of the lineup page by page. */
  private readonly autoLoadForFilter = effect(() => {
    if (this.query().trim() || this.groupFilter()) void this.loadAllRemaining();
  });

  ngOnInit(): void {
    void this.load();
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
  }

  private readonly bindSentinel = effect(() => {
    const el = this.sentinel()?.nativeElement;
    this.observer?.disconnect();
    if (!el) return;
    this.observer = new IntersectionObserver(
      (observed) => {
        if (observed[0]?.isIntersecting) void this.loadMore();
      },
      { rootMargin: '600px' },
    );
    this.observer.observe(el);
  });

  private async load(): Promise<void> {
    this.loading.set(true);
    this.page.set(1);
    try {
      this.applyPage(await this.api.getOnNow({ page: 1, pageSize: PAGE_SIZE }), true);
    } catch {
      // handled by the global error interceptor
    } finally {
      this.loading.set(false);
    }
  }

  async loadMore(): Promise<void> {
    if (!this.hasMore() || this.loadingMore() || this.loading()) return;
    this.loadingMore.set(true);
    const nextPage = this.page() + 1;
    try {
      const res = await this.api.getOnNow({ page: nextPage, pageSize: PAGE_SIZE });
      this.page.set(nextPage);
      this.applyPage(res, false);
    } catch {
      // handled by the global error interceptor
    } finally {
      this.loadingMore.set(false);
    }
  }

  private async loadAllRemaining(): Promise<void> {
    if (this.loadingAll) return;
    this.loadingAll = true;
    try {
      while (this.hasMore() && !this.loading()) await this.loadMore();
    } finally {
      this.loadingAll = false;
    }
  }

  /** Narrow fallback for the old bare-array response, kept for one release. */
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
