import { AnimationCallbackEvent, Component, DestroyRef, ElementRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import type { Media } from '../../../core/services/api/media.service';
import { BackgroundService } from '../../../core/services/background.service';
import { kindOf, mediaDetailLink } from '../../../core/media-kinds';
import { episodeCode, type NextUp } from '../../../shared/utils/media-play.util';
import { keepRouteFresh } from '../../../core/services/keep-route-fresh';
import { AddToPlaylistService } from '../../../core/services/add-to-playlist.service';
import { MediaStartService } from '../../../core/services/media-start.service';
import { keyboardModality } from '../../../core/services/focusable.constants';
import { mediaQuerySignal } from '../../../core/utils/viewport';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import { TvRowDirective } from '../../directives/tv-row.directive';
import { heroDesktopLayout } from '../hero-base/hero-base';
import { HeroMetaRowComponent, type HeroChip } from '../hero-base/hero-meta-row';
import { LucideDynamicIcon } from '@lucide/angular';
import { icons } from '../../icons';
import { MobileFanartHeroComponent } from '../mobile-fanart-hero';
import { clearHeroTitle, clearPosterStamps, stampHeroTitle, stampPoster } from '../../utils/view-transition';

/** The episode a series slide plays, with the loaded series it belongs to. */
interface SeriesStart {
  series: Media;
  next: NextUp;
  resuming: boolean;
}

/** A few featured titles, one at a time: backdrop through the global background, text swapped with the keyframes in the stylesheet.
 *  Before its items arrive it draws an empty frame of its final size, so the page under it never moves. */
@Component({
  selector: 'app-hero-carousel',
  imports: [RouterLink, TranslatePipe, ResolveUrlPipe, TvRowDirective, HeroMetaRowComponent, LucideDynamicIcon, MobileFanartHeroComponent],
  templateUrl: './hero-carousel.html',
  styleUrl: './hero-carousel.css',
  host: {
    class: 'block',
    '[class.hc-desktop]': 'desktop()',
    '[class.hc-phone]': '!desktop()',
    '(pointerenter)': 'hovered.set($event.pointerType === \'mouse\')',
    '(pointerleave)': 'hovered.set(false)',
    '(focusin)': 'focused.set(keyboardFocus())',
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

  private readonly background = inject(BackgroundService);
  private readonly start = inject(MediaStartService);
  private readonly router = inject(Router);
  private readonly playlists = inject(AddToPlaylistService);
  private readonly host: HTMLElement = inject(ElementRef).nativeElement;
  protected readonly desktop = heroDesktopLayout();

  protected readonly index = signal(0);
  /** No slide has changed yet: the first one appears without waiting for an outgoing text. */
  protected readonly changed = signal(false);
  protected readonly hovered = signal(false);
  protected readonly keyboardFocus = keyboardModality;
  protected readonly focused = signal(false);
  protected readonly hidden = signal(document.hidden);
  protected touchX = 0;
  /** The cached route is off screen: the timer stops and the backdrop is handed back. */
  private readonly parked = keepRouteFresh({
    onDetach: () => {
      clearTimeout(this.timer);
      this.background.suspend(this);
    },
    // Episodes may have been watched meanwhile: each series resolves its next one again.
    onAttach: () => {
      this.episodes.set(new Map());
      this.claimBackdrop();
    },
  });
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly reducedMotion = mediaQuerySignal('(prefers-reduced-motion: reduce)');

  protected readonly current = computed(() => {
    const list = this.items();
    return list.length ? list[this.index() % list.length] : null;
  });
  protected readonly running = computed(
    () =>
      !this.reducedMotion() && !this.hovered() && !this.focused() && !this.hidden() && !this.parked() && this.items().length > 1,
  );
  /** The facts line: year, runtime and two genres as a title page shows them; the phone keeps year and genres. */
  protected readonly parts = computed(() => {
    const m = this.current();
    if (!m) return [];
    const runtime = this.desktop() && m.runtime ? `${m.runtime}min` : '';
    return [m.year ? String(m.year) : '', runtime, (m.genres ?? []).slice(0, 2).join(', ')].filter(Boolean);
  });
  protected readonly chips = computed<HeroChip[]>(() => {
    const m = this.current();
    return m && this.desktop() ? [{ label: kindOf(m.type).requestLabelKey, cls: 'badge badge-ghost' }] : [];
  });

  /** The episode a series slide plays, resolved once per series while the page is on screen; null when none is on disk. */
  private readonly episodes = signal(new Map<number, SeriesStart | null>());
  /** What the primary button does: play (a series once its episode is known, with its code), else open the detail page. */
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
        .then((r) => (r.next ? { series: r.media, next: r.next, resuming: r.resuming } : null))
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
      this.claimBackdrop();
    });
    inject(DestroyRef).onDestroy(() => this.background.suspend(this));
  }

  /** Desktop and TV draw the picture as the page backdrop; the phone draws its own. */
  private claimBackdrop(): void {
    const m = this.current();
    if (!m || this.parked() || !this.desktop()) return;
    this.background.set(this, m.fanartUrl ?? null, { hero: true });
  }

  protected go(i: number): void {
    const n = this.items().length;
    if (!n) return;
    const next = ((i % n) + n) % n;
    if (next === this.index()) return;
    // The way back pairs with the slide that was opened, not one that replaced it.
    clearHeroTitle();
    this.changed.set(true);
    this.index.set(next);
  }

  /** The leaving slide is inert so focus cannot land on a button that is about to go; it is removed when its keyframes end. */
  protected leave(e: AnimationCallbackEvent): void {
    e.target.setAttribute('inert', '');
    e.target.classList.add('hc-out');
    void Promise.allSettled(e.target.getAnimations().map((a) => a.finished)).then(() => e.animationComplete());
  }

  protected onVisibility(): void {
    this.hidden.set(document.hidden);
  }

  protected swipe(x: number): void {
    const dx = x - this.touchX;
    if (Math.abs(dx) > 50) this.go(this.index() + (dx < 0 ? 1 : -1));
  }

  protected primaryAction(m: Media): void {
    if (!this.primary().play) {
      this.stampDetail();
      void this.router.navigate(this.detailLink(), { state: { media: m } });
      return;
    }
    const ep = this.episodes().get(m.id);
    const started = ep ? this.start.playNext(ep.series, ep.next) : this.start.start(m);
    started.catch(() => {
      /* the global error toast reports it */
    });
  }

  /** Pairs the slide with the page it opens, both ways: its title with the page title, the phone picture with the page's fanart. */
  protected stampDetail(): void {
    if (!('startViewTransition' in document)) return;
    const picture = this.desktop() ? null : this.host.querySelector<HTMLElement>('app-mobile-fanart-hero img:not([aria-hidden])');
    const m = this.current();
    if (picture && m) stampPoster(picture, m.id);
    else clearPosterStamps();
    const title = this.host.querySelector<HTMLElement>('.hc-slide:not(.hc-out) :is(.hc-logo, .hc-title)');
    if (title) stampHeroTitle(title);
  }

  protected addToPlaylist(m: Media): void {
    this.playlists.open({ mediaId: m.id });
  }
}
