import { Component, computed, effect, inject, input, signal, OnInit, OnDestroy } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { RouterOutlet, RouterLink, Router, NavigationEnd } from '@angular/router';
import { Title } from '@angular/platform-browser';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { Location } from '@angular/common';
import { Subscription, filter, map, of, switchMap } from 'rxjs';
import { LucideDynamicIcon, type LucideIconData } from '@lucide/angular';
import { icons } from '../../icons';
import { TvService } from '../../../core/services/tv.service';
import { BackgroundService } from '../../../core/services/background.service';
import { PageScrollerService } from '../../../core/services/page-scroller.service';
import { NavIconComponent } from '../../layout/nav-icon';

export interface SettingsNavItem {
  id: string;
  route: string;
  labelKey: string;
  /** A contribution's icon name, or icon data from `icons`. */
  icon?: string | LucideIconData;
}

export interface SettingsNavSection {
  id: string;
  /** Titled sections get a separator and a heading; translated, falling back to the literal string. */
  label?: string;
  items: readonly SettingsNavItem[];
}

/** The longest route prefixing the path wins, so a nested page lights its own entry rather than its parent's. */
export function activeNavItem(sections: readonly SettingsNavSection[], url: string): SettingsNavItem | null {
  const path = url.split(/[?#]/)[0];
  let best: SettingsNavItem | null = null;
  for (const item of sections.flatMap((s) => s.items)) {
    if (path !== item.route && !path.startsWith(`${item.route}/`)) continue;
    if (!best || item.route.length > best.route.length) best = item;
  }
  return best;
}

/** The layout of the settings areas (account, app, admin): their sections in the nav rail's look, pinned from `lg`. */
@Component({
  selector: 'app-settings-drawer',
  imports: [RouterOutlet, RouterLink, TranslatePipe, LucideDynamicIcon, NavIconComponent],
  templateUrl: './settings-drawer.html',
})
export class SettingsDrawerComponent implements OnInit, OnDestroy {
  protected readonly icons = icons;

  private readonly location = inject(Location);
  private readonly router = inject(Router);
  private readonly titleService = inject(Title);
  private readonly translate = inject(TranslateService);
  private readonly pageScroller = inject(PageScrollerService);
  protected readonly background = inject(BackgroundService);
  readonly tv = inject(TvService);

  /** Layout name, shown in the header and used as the tab-title suffix. */
  readonly title = input.required<string>();
  readonly icon = input.required<LucideIconData>();
  readonly sections = input.required<readonly SettingsNavSection[]>();

  readonly navbarHidden = signal(false);

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );
  protected readonly active = computed(() => activeNavItem(this.sections(), this.url()));

  private readonly activePage = toSignal(
    toObservable(this.active).pipe(switchMap((item) => (item ? this.translate.stream(item.labelKey) : of('')))),
    { initialValue: '' },
  );

  /** These shells sit outside the LayoutComponent that owns document.title, which would keep the previous page's. */
  private readonly titleEffect = effect(() => {
    const page = this.activePage();
    const layout = this.title();
    this.titleService.setTitle(page ? `${page} | ${layout}` : layout);
  });

  private lastScrollY = 0;
  private scrollSub?: Subscription;
  private readonly onScroll = () => {
    const y = this.pageScroller.offset();
    if (Math.abs(y - this.lastScrollY) < 10) return;
    this.navbarHidden.set(y > this.lastScrollY && y > 56);
    this.lastScrollY = y;
  };

  ngOnInit() {
    this.scrollSub = this.pageScroller.changes().subscribe(this.onScroll);
  }

  ngOnDestroy() {
    this.scrollSub?.unsubscribe();
  }

  goBack() {
    this.location.back();
  }
}
