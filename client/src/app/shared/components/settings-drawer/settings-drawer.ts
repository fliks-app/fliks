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

  /** Layout name — shown in the header and used as the tab-title suffix. */
  readonly title = input('');
  readonly backLabel = input('Retour');
  readonly drawerId = input('settings-drawer');

  readonly navbarHidden = signal(false);
  readonly tv = inject(TvService);

  /** Active sidebar entry label, re-read from the menu on each navigation. */
  private readonly activePage = signal('');
  private routerSub?: Subscription;

  /**
   * Drives the browser tab title: `"<active page> | <layout>"` (e.g.
   * "Général | Administration"), or the layout name alone before a page
   * resolves. These shells live outside the main LayoutComponent that otherwise
   * owns document.title, so without this the title keeps whatever the previous
   * page (e.g. a media detail) left.
   */
  private readonly titleEffect = effect(() => {
    const page = this.activePage();
    const layout = this.title();
    this.titleService.setTitle(page ? `${page} | ${layout}` : layout);
  });

  private lastScrollY = 0;
  private readonly onScroll = () => {
    const y = window.scrollY;
    if (Math.abs(y - this.lastScrollY) < 10) return;
    this.navbarHidden.set(y > this.lastScrollY && y > 56);
    this.lastScrollY = y;
  };

  ngOnInit() {
    window.addEventListener('scroll', this.onScroll, { passive: true });

    this.routerSub = this.router.events
      .pipe(filter((e) => e instanceof NavigationEnd))
      .subscribe(() => this.activePage.set(this.readActivePageLabel()));
    // Initial read — a direct load fires no NavigationEnd after mount.
    queueMicrotask(() => this.activePage.set(this.readActivePageLabel()));
  }

  ngOnDestroy() {
    window.removeEventListener('scroll', this.onScroll);
    this.routerSub?.unsubscribe();
  }

  /** Label of the deepest sidebar entry whose route prefixes the current URL.
   *  Scoped to the menu (so routed-content links don't leak in) and matched by
   *  href prefix rather than the `.active` class, so it doesn't depend on
   *  routerLinkActive's update timing. */
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
