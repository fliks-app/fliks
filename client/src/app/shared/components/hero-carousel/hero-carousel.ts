import { Component, DestroyRef, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import type { Media } from '../../../core/services/api/media.service';
import { BackgroundService } from '../../../core/services/background.service';
import { kindOf, mediaDetailLink } from '../../../core/media-kinds';
import { keepRouteFresh } from '../../../core/services/keep-route-fresh';
import { MediaStartService } from '../../../core/services/media-start.service';
import { NavbarService } from '../../../core/services/navbar.service';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import { TvRowDirective } from '../../directives/tv-row.directive';
import { heroDesktopLayout } from '../hero-base/hero-base';
import { HeroMetaRowComponent } from '../hero-base/hero-meta-row';
import { LucideInfo, LucidePause, LucidePlay } from '@lucide/angular';
import { MobileFanartHeroComponent } from '../mobile-fanart-hero';

/** A few featured titles, one at a time: backdrop through the global background, text swapped with the keyframes in the stylesheet. */
@Component({
  selector: 'app-hero-carousel',
  imports: [RouterLink, TranslatePipe, ResolveUrlPipe, TvRowDirective, HeroMetaRowComponent, LucideInfo, LucidePause, LucidePlay, MobileFanartHeroComponent],
  templateUrl: './hero-carousel.html',
  styleUrl: './hero-carousel.css',
  host: {
    class: 'block',
    '(pointerenter)': 'hovered.set($event.pointerType === \'mouse\')',
    '(pointerleave)': 'hovered.set(false)',
    '(focusin)': 'focused.set($any($event.target).matches(\':focus-visible\'))',
    '(focusout)': 'focused.set(false)',
    '(touchstart)': 'touchX = $event.touches[0].clientX',
    '(touchend)': 'swipe($event.changedTouches[0].clientX)',
    '(document:visibilitychange)': 'onVisibility()',
  },
})
export class HeroCarouselComponent {
  readonly items = input.required<Media[]>();
  readonly autoAdvanceMs = input(7000);
  readonly height = input<'full' | 'compact'>('full');

  private readonly background = inject(BackgroundService);
  private readonly navbar = inject(NavbarService);
  private readonly start = inject(MediaStartService);
  protected readonly desktop = heroDesktopLayout();

  protected readonly index = signal(0);
  /** No slide has changed yet: the first one appears without waiting for an outgoing text. */
  protected readonly changed = signal(false);
  protected readonly hovered = signal(false);
  protected readonly focused = signal(false);
  protected readonly hidden = signal(document.hidden);
  protected readonly userPaused = signal(false);
  protected touchX = 0;
  /** The cached route is off screen: the timer stops and the global chrome is handed back. */
  private readonly parked = keepRouteFresh({
    onDetach: () => {
      clearTimeout(this.timer);
      this.releaseChrome();
    },
    onAttach: () => this.claimChrome(),
  });
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  protected readonly current = computed(() => {
    const list = this.items();
    return list.length ? list[this.index() % list.length] : null;
  });
  protected readonly running = computed(
    () =>
      !this.reducedMotion && !this.userPaused() && !this.hovered() && !this.focused() && !this.hidden() && !this.parked() && this.items().length > 1,
  );
  protected readonly metaParts = computed(() => {
    const m = this.current();
    if (!m) return [];
    const parts = [m.year ? String(m.year) : '', m.runtime ? `${m.runtime}min` : '', (m.genres ?? []).slice(0, 3).join(', ')];
    return parts.filter(Boolean);
  });
  protected readonly opensDetail = computed(() => {
    const m = this.current();
    return !m || kindOf(m.type).hasSeasons;
  });
  protected readonly detailLink = computed(() => {
    const m = this.current();
    return m ? mediaDetailLink(m.type, m.id) : [];
  });

  constructor() {
    effect((onCleanup) => {
      if (!this.running()) return;
      this.index();
      this.timer = setTimeout(() => this.go(this.index() + 1), this.autoAdvanceMs());
      onCleanup(() => clearTimeout(this.timer));
    });
    // Each slide change is a new claim, so the backdrop crossfades.
    effect(() => {
      this.current();
      this.claimChrome();
    });
    inject(DestroyRef).onDestroy(() => this.releaseChrome());
  }

  private entered = false;

  private claimChrome(): void {
    const m = this.current();
    if (!m || this.parked()) return;
    if (this.desktop()) this.background.set(this, m.fanartUrl ?? null);
    // Only the full-bleed hero takes over the navbar; a compact strip leaves the page's own chrome.
    if (this.height() !== 'full') return;
    this.entered = true;
    this.navbar.enterHeroPage('');
  }

  private releaseChrome(): void {
    if (this.entered) this.navbar.leaveHeroPage();
    this.entered = false;
    this.background.suspend(this);
  }

  protected go(i: number): void {
    const n = this.items().length;
    if (!n) return;
    const next = ((i % n) + n) % n;
    if (next === this.index()) return;
    this.changed.set(true);
    this.index.set(next);
  }

  protected onVisibility(): void {
    this.hidden.set(document.hidden);
  }

  protected swipe(x: number): void {
    const dx = x - this.touchX;
    if (Math.abs(dx) > 50) this.go(this.index() + (dx < 0 ? 1 : -1));
  }

  protected async play(m: Media): Promise<void> {
    try {
      await this.start.start(m);
    } catch {
      /* the global error toast reports it */
    }
  }
}
