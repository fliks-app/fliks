import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
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
  LucideCircle,
} from '@lucide/angular';
import { CardAction, CardActionsService } from '../../../core/services/card-actions.service';
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
    TranslateModule,
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
    LucideCircle,
    NgTemplateOutlet,
    RouterLink,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './card-actions-panel.html',
})
export class CardActionsPanelComponent {
  readonly service = inject(CardActionsService);

  readonly actions = computed(() => this.service.actions() ?? []);
  readonly title = this.service.title;
  readonly imageUrl = this.service.imageUrl;
  readonly imageAspect = this.service.imageAspect;
  readonly subtitle = this.service.subtitle;

  /** `button` aligns the menu's right edge under the ⋯ trigger; `card` centres
   *  it under the card figure. */
  readonly placement = computed(() =>
    this.service.placement() === 'button' ? 'bottom-end' : 'bottom-center',
  );
  /** Compact under the ⋯ button; about the card's width under a figure. */
  readonly width = computed(() => {
    const anchor = this.service.anchor();
    if (this.service.placement() === 'button' || !anchor) return 220;
    return Math.min(280, Math.max(220, anchor.getBoundingClientRect().width));
  });

  onClose() {
    this.service.close();
  }

  /** A link row navigates on its own; the panel just gets out of the way. */
  closeForRoute() {
    this.service.close();
  }

  trigger(action: CardAction) {
    if (action.disabled) return;
    this.service.close();
    // Defer so the close transition lands before the action navigates/mutates.
    queueMicrotask(() => action.run());
  }
}
