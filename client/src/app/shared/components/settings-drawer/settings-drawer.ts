import {
  Component,
  signal,
  effect,
  input,
  inject,
  OnInit,
  OnDestroy,
  ElementRef,
  viewChild,
} from '@angular/core';
import {
  RouterOutlet,
  RouterLink,
  Router,
  NavigationEnd,
} from '@angular/router';
import { Title } from '@angular/platform-browser';
import { Location } from '@angular/common';
import { Subscription, filter } from 'rxjs';
import { LucideChevronLeft, LucideMenu } from '@lucide/angular';
import { TvService } from '../../../core/services/tv.service';
import { PageScrollerService } from '../../../core/services/page-scroller.service';

@Component({
  selector: 'app-settings-drawer',
  imports: [RouterOutlet, RouterLink, LucideChevronLeft, LucideMenu],
  templateUrl: './settings-drawer.html',
})
export class SettingsDrawerComponent implements OnInit, OnDestroy {
  private readonly location = inject(Location);
  private readonly router = inject(Router);
  private readonly titleService = inject(Title);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly pageScroller = inject(PageScrollerService);

  /** Layout name — shown in the header and used as the tab-title suffix. */
  readonly title = input('');
  readonly backLabel = input('Retour');
  readonly drawerId = input('settings-drawer');

  readonly navbarHidden = signal(false);
  readonly tv = inject(TvService);

  /** Active sidebar entry label, re-read from the menu on each navigation. */
  private readonly activePage = signal('');
  private routerSub?: Subscription;

  /** Sets the tab title (`"<page> | <layout>"`); these shells sit outside the LayoutComponent that owns document.title, which would keep the previous page's. */
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

    this.routerSub = this.router.events
      .pipe(filter((e) => e instanceof NavigationEnd))
      .subscribe(() => this.activePage.set(this.readActivePageLabel()));
    // Initial read — a direct load fires no NavigationEnd after mount.
    queueMicrotask(() => this.activePage.set(this.readActivePageLabel()));
  }

  ngOnDestroy() {
    this.scrollSub?.unsubscribe();
    this.routerSub?.unsubscribe();
  }

  /** Deepest sidebar entry whose href prefixes the URL, scoped to the menu and matched by href rather than `.active` to avoid routerLinkActive timing. */
  private readActivePageLabel(): string {
    const menu = this.host.nativeElement.querySelector('ul.menu');
    if (!menu) return '';
    const url = this.router.url.split(/[?#]/)[0];
    let best: HTMLAnchorElement | null = null;
    let bestLen = -1;
    for (const a of Array.from(
      menu.querySelectorAll<HTMLAnchorElement>('a[href]'),
    )) {
      const href = a.getAttribute('href') ?? '';
      if (
        (url === href || url.startsWith(`${href}/`)) &&
        href.length > bestLen
      ) {
        bestLen = href.length;
        best = a;
      }
    }
    return best ? (best.textContent ?? '').replace(/\s+/g, ' ').trim() : '';
  }

  goBack() {
    this.location.back();
  }

}
