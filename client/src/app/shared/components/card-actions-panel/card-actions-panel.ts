import {
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import {
  LucidePlay,
  LucideExternalLink,
  LucideEye,
  LucideEyeOff,
  LucideTrash2,
  LucideListPlus,
  LucideUserPlus,
  LucideCheck,
  LucideListChecks,
  LucideClipboardList,
  LucideSettings,
  LucideFolder,
  LucideCaptions,
  LucideRotateCcw,
  LucideScanLine,
  LucideSearch,
  LucideDownload,
  LucideChevronRight,
  LucideArrowLeft,
  LucideDatabase,
  LucideSlidersHorizontal,
  LucideHeart,
  LucideCircle,
  LucideFileText,
  LucideLanguages,
  LucideArrowRightLeft,
  LucideMoveHorizontal,
  LucideWandSparkles,
  LucideBadgeCheck,
  LucideBan,
  LucideVolume2,
  LucideCode,
  LucideSmile,
  LucideImage,
  LucideThermometer,
  LucideMaximize2,
  LucideClock,
  LucideZap,
} from '@lucide/angular';
import { CardAction, CardActionsService } from '../../../core/services/card-actions.service';
import { TvService } from '../../../core/services/tv.service';
import { DeviceService } from '../../../core/services/device.service';
import { PopoverMenuComponent } from '../popover-menu';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import { CachedSrcDirective } from '../../directives/cached-src.directive';

/**
 * Singleton actions menu for cards, mounted once at the layout level. It reads
 * its content from `CardActionsService` and delegates all chrome — anchored
 * dropdown on desktop, bottom sheet on touch/TV, positioning, focus, spatial-nav
 * scoping and dismiss — to `app-popover-menu`.
 */
@Component({
  selector: 'app-card-actions-panel',
  standalone: true,
  imports: [
    CachedSrcDirective,
    TranslatePipe,
    PopoverMenuComponent,
    ResolveUrlPipe,
    LucidePlay,
    LucideExternalLink,
    LucideEye,
    LucideEyeOff,
    LucideTrash2,
    LucideListPlus,
    LucideUserPlus,
    LucideCheck,
    LucideListChecks,
    LucideClipboardList,
    LucideSettings,
    LucideFolder,
    LucideCaptions,
    LucideRotateCcw,
    LucideScanLine,
    LucideSearch,
    LucideDownload,
  LucideChevronRight,
  LucideArrowLeft,
  LucideDatabase,
  LucideSlidersHorizontal,
  LucideHeart,
    LucideCircle,
    LucideFileText,
    LucideLanguages,
    LucideArrowRightLeft,
    LucideMoveHorizontal,
    LucideWandSparkles,
    LucideBadgeCheck,
    LucideBan,
    LucideVolume2,
    LucideCode,
    LucideSmile,
    LucideImage,
    LucideThermometer,
    LucideMaximize2,
    LucideClock,
    LucideZap,
    NgTemplateOutlet,
    RouterLink,
  ],
  templateUrl: './card-actions-panel.html',
})
export class CardActionsPanelComponent {
  readonly service = inject(CardActionsService);
  private readonly tv = inject(TvService);
  private readonly device = inject(DeviceService);

  /** Same condition `app-popover-menu` uses to render a sheet instead of an
   *  anchored dropdown: there is no room beside the panel for a flyout, so a
   *  submenu takes over the sheet with a back row. */
  protected readonly sheet = computed(() => this.tv.isTv() || this.device.isTouch());

  readonly actions = computed(() => this.service.actions() ?? []);
  readonly title = this.service.title;
  readonly imageUrl = this.service.imageUrl;
  readonly imageAspect = this.service.imageAspect;
  readonly subtitle = this.service.subtitle;

  /** `button` drops the menu under the ⋯ trigger, right edges flush;
   *  `card-top` overlays the card from its top edge; `card` centres it under
   *  the card figure. */
  readonly placement = computed(() => {
    switch (this.service.placement()) {
      case 'button':
        return 'bottom-end';
      case 'card-top':
        return 'start-end';
      default:
        return 'bottom-center';
    }
  });
  /** Compact under the ⋯ button; about the card's width under a figure. */
  readonly width = computed(() => {
    const anchor = this.service.anchor();
    // Wider than a card menu used to need: the rows now include submenu parents
    // and longer labels, and a wrapped row reads badly.
    if (this.service.placement() !== 'card' || !anchor) return 280;
    return Math.min(340, Math.max(280, anchor.getBoundingClientRect().width));
  });

  constructor() {
    // Collapse on every open: a group left unfolded from last time would make
    // the menu a different height than the one the user reached for.
    effect(() => {
      if (this.service.open()) {
        this.closeSub();
        this.slide.set('');
      }
    });
  }

  onClose() {
    this.service.close();
  }

  /** The one open submenu, with the row it hangs off. Only one at a time: a
   *  second panel beside the first would overlap it. */
  private readonly openSubmenu = signal<CardAction | null>(null);
  protected readonly subAnchor = signal<HTMLElement | null>(null);

  /** Which way the sheet panel last moved, so the incoming list slides in
   *  from the matching side. */
  protected readonly slide = signal<'' | 'back'>('');

  /** Submenu shown in place of the root list (sheet only). */
  protected readonly sheetSub = computed(() => (this.sheet() ? this.openSubmenu() : null));

  isOpen(a: CardAction): boolean {
    return this.openSubmenu() === a;
  }

  openSub(a: CardAction, anchor: HTMLElement) {
    if (this.isOpen(a)) return this.closeSub();
    this.subAnchor.set(anchor);
    this.openSubmenu.set(a);
  }

  /** Sheet back row: same as closing the submenu, but the root list slides
   *  back in from the left. */
  backToRoot() {
    this.slide.set('back');
    this.closeSub();
  }

  closeSub() {
    this.openSubmenu.set(null);
    // Dropped too: this panel is a singleton, and an element from a page that
    // has since been destroyed still positions the next flyout.
    this.subAnchor.set(null);
  }

  /** A link row navigates on its own; the panel just gets out of the way. */
  closeForRoute() {
    this.service.close();
  }

  trigger(action: CardAction) {
    if (action.disabled) return;
    // The flyout is a second panel, so closing the main one does not take it.
    this.closeSub();
    this.service.close();
    // Defer so the close transition lands before the action navigates/mutates.
    queueMicrotask(() => action.run());
  }
}
