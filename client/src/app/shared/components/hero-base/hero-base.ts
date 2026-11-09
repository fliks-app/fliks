import { Component, computed, inject, input } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import type { MediaType } from '../../../core/enums/media-type.enum';
import { DeviceService } from '../../../core/services/device.service';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import { NavbarService } from '../../../core/services/navbar.service';
import { MD_BREAKPOINT_QUERY, mediaQuerySignal } from '../../../core/utils/viewport';
import { SpoilerDirective } from '../../directives/spoiler.directive';
import { TvRowDirective } from '../../directives/tv-row.directive';
import { HeroPosterComponent } from '../hero-poster/hero-poster';
import { MobileFanartHeroComponent } from '../mobile-fanart-hero';
import { SynopsisComponent } from '../synopsis/synopsis';

/** A badge of the meta row, with its daisyUI classes. */
export interface HeroChip {
  /** A translation key, or a name that has none (a library) and shows as is. */
  label: string;
  cls: string;
}

/** The desktop tree from `md` up, and always on a TV (`tv:` in CSS); the mobile one otherwise. Call from an injection context. */
export function heroDesktopLayout() {
  const device = inject(DeviceService);
  const mdUp = mediaQuerySignal(MD_BREAKPOINT_QUERY);
  return computed(() => device.isTv() || mdUp());
}

/** The hero every title page shares, library or preview: cover or fanart, title, facts row, synopsis and the slots a page fills.
 *  Slots: `heroMeta` (before the meta row), `heroTags` (after it), `heroActions` (the button row), `heroStatus` (under it), and the default one. */
@Component({
  selector: 'app-hero-base',
  imports: [DecimalPipe, RouterLink, ResolveUrlPipe, TranslatePipe, SpoilerDirective, TvRowDirective, HeroPosterComponent, MobileFanartHeroComponent, SynopsisComponent],
  templateUrl: './hero-base.html',
  host: { class: 'block' },
})
export class HeroBaseComponent {
  /** Null while the title is not known yet; the hero then draws its skeleton. */
  readonly title = input<string | null>(null);
  /** The title links here when given (an episode's series). */
  readonly titleLink = input<string[] | null>(null);
  readonly subtitle = input<string | null>(null);
  readonly mediaType = input.required<MediaType>();
  readonly posterUrl = input<string | null>(null);
  /** Landscape art for the mobile hero; without it the mobile hero is the blurred cover with the poster over it. */
  readonly fanartUrl = input<string | null>(null);
  readonly posterMode = input<'poster' | 'still'>('poster');
  /** Anti-spoiler: blur the hero and the still until clicked. */
  readonly spoilerImage = input(false);
  readonly viewTransitionName = input<string | null>(null);
  /** The kind has landscape art to come: the mobile hero keeps its fanart layout while the title loads, so nothing jumps. */
  readonly expectFanart = input(false);
  /** Nothing is known of the title yet: a missing poster is a skeleton, not a glyph. */
  readonly loading = input(false);
  readonly rating = input<number | null>(null);
  /** The plain-text facts of the meta row (year, runtime, status...). */
  readonly metaParts = input<string[]>([]);
  readonly chips = input<HeroChip[]>([]);
  readonly overview = input<string | null>(null);
  readonly overviewMasked = input(false);
  /** Closer to the facts above than the default gap, when a line sits between them and the buttons. */
  readonly tightActions = input(false);

  protected readonly navbar = inject(NavbarService);
  protected readonly desktop = heroDesktopLayout();
  protected readonly fanartLayout = computed(() => !!this.fanartUrl() || this.expectFanart());
  protected readonly showMetaRow = computed(() => !!(this.rating() || this.metaParts().length || this.chips().length));
  protected readonly titleClass = computed(() =>
    this.desktop() ? 'text-2xl lg:text-4xl font-bold tracking-tight' : 'text-3xl font-semibold tracking-tight leading-tight',
  );
}
