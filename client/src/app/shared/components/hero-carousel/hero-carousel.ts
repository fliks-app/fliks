import { AnimationCallbackEvent, Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import type { Media } from '../../../core/services/api/media.service';
import { BackgroundService } from '../../../core/services/background.service';
import { kindOf, mediaDetailLink } from '../../../core/media-kinds';
import { episodeCode, type NextUp } from '../../../shared/utils/media-play.util';
import { keepRouteFresh } from '../../../core/services/keep-route-fresh';
import { AddToPlaylistService } from '../../../core/services/add-to-playlist.service';
import { MediaStartService } from '../../../core/services/media-start.service';
import { NavbarService } from '../../../core/services/navbar.service';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import { TvRowDirective } from '../../directives/tv-row.directive';
import { heroDesktopLayout } from '../hero-base/hero-base';
import { HeroMetaRowComponent } from '../hero-base/hero-meta-row';
import { LucideDynamicIcon } from '@lucide/angular';
import { icons } from '../../icons';
import { MobileFanartHeroComponent } from '../mobile-fanart-hero';

/** A few featured titles, one at a time: backdrop through the global background, text swapped with the keyframes in the stylesheet. */
@Component({
  selector: 'app-hero-carousel',
  imports: [NgTemplateOutlet, RouterLink, TranslatePipe, ResolveUrlPipe, TvRowDirective, HeroMetaRowComponent, LucideDynamicIcon, MobileFanartHeroComponent],
  templateUrl: './hero-carousel.html',
  styleUrl: './hero-carousel.css',
  host: {
    class: 'block',
    '[class.mb-4]': "height() === 'compact'",
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
  protected readonly icons = icons;

  readonly items = input.required<Media[]>();
  readonly autoAdvanceMs = input(7000);
  readonly height = input<'full' | 'compact'>('full');

  private readonly background = inject(BackgroundService);
  private readonly navbar = inject(NavbarService);
  private readonly start = inject(MediaStartService);
  private readonly playlists = inject(AddToPlaylistService);
  protected readonly desktop = heroDesktopLayout();

  protected readonly index = signal(0);
  /** No slide has changed yet: the first one appears without waiting for an outgoing text. */
  protected readonly changed = signal(false);
  protected readonly hovered = signal(false);
  protected readonly focused = signal(false);
  protected readonly hidden = signal(document.hidden);
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
      !this.reducedMotion && !this.hovered() && !this.focused() && !this.hidden() && !this.parked() && this.items().length > 1,
  );
  /** Phone facts line: year and two genres. */
  protected readonly metaParts = computed(() => {
    const m = this.current();
    return m ? [m.year ? String(m.year) : '', (m.genres ?? []).slice(0, 2).join(', ')].filter(Boolean) : [];
  });
  /** Desktop and TV facts: kind badge, year, runtime as "2 h 53", rating and two genres. */
  protected readonly facts = computed(() => {
    const m = this.current();
    if (!m) return null;
    const h = Math.floor(m.runtime / 60);
    return {
      kindKey: kindOf(m.type).requestLabelKey,
      year: m.year ? String(m.year) : '',
      runtime: !m.runtime ? '' : h ? `${h} h ${String(m.runtime % 60).padStart(2, '0')}` : `${m.runtime} min`,
      rating: m.rating ? m.rating.toFixed(1) : '',
      genres: (m.genres ?? []).slice(0, 2).join(' · '),
    };
  });
  /** The episode a series slide plays, loaded once per series; null while loading or when none is on disk. */
  private readonly episodes = signal(new Map<number, { next: NextUp; resuming: boolean } | null>());
  /** What the primary button of the current slide does: play (an episode of a series, with its label), or open the detail page of a series with nothing to play. */
  protected readonly primary = computed<{ play: boolean; labelKey: string; code?: string }>(() => {
    const m = this.current();
    if (!m) return { play: false, labelKey: 'hero_carousel.details' };
    if (!kindOf(m.type).hasSeasons) return { play: true, labelKey: 'hero_carousel.play' };
    const ep = this.episodes().get(m.id);
    if (!ep) return { play: false, labelKey: 'hero_carousel.details' };
    return { play: true, labelKey: ep.resuming ? 'hero_carousel.resume_episode' : 'hero_carousel.play_episode', code: episodeCode(ep.next) };
  });
  protected readonly detailLink = computed(() => {
    const m = this.current();
    return m ? mediaDetailLink(m.type, m.id) : [];
  });

  constructor() {
    effect(() => {
      const m = this.current();
      if (!m || !kindOf(m.type).hasSeasons || untracked(() => this.episodes().has(m.id))) return;
      void this.start
        .nextUpOf(m)
        .then((r) => (r.next ? { next: r.next, resuming: r.resuming } : null))
        .catch(() => null)
        .then((v) => this.episodes.update((map) => new Map(map).set(m.id, v)));
    });
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
    if (this.desktop()) this.background.set(this, m.fanartUrl ?? null, { hero: this.height() });
    // Only the full-bleed mobile hero takes over the navbar; desktop keeps the page's chrome (no back button on home).
    if (this.height() !== 'full' || this.desktop()) return;
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

  /** The leaving slide is inert so focus cannot land on a button that is about to go; it is removed when its keyframes end. */
  protected leave(e: AnimationCallbackEvent): void {
    e.target.setAttribute('inert', '');
    e.target.classList.add('hc-out');
    void getComputedStyle(e.target).animationName;
    void Promise.allSettled(e.target.getAnimations().map((a) => a.finished)).then(() => e.animationComplete());
  }

  protected onVisibility(): void {
    this.hidden.set(document.hidden);
  }

  protected swipe(x: number): void {
    const dx = x - this.touchX;
    if (Math.abs(dx) > 50) this.go(this.index() + (dx < 0 ? 1 : -1));
  }

  protected addToPlaylist(m: Media): void {
    this.playlists.open({ mediaId: m.id });
  }

  protected async play(m: Media): Promise<void> {
    try {
      await this.start.start(m);
    } catch {
      /* the global error toast reports it */
    }
  }
}
