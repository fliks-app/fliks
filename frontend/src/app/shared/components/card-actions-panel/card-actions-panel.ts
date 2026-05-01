import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import {
  LucidePlay,
  LucideExternalLink,
  LucideEye,
  LucideEyeOff,
  LucideTrash2,
} from '@lucide/angular';
import { CardAction, CardActionsService } from '../../../core/services/card-actions.service';
import { TvService } from '../../../core/services/tv.service';
import { DeviceService } from '../../../core/services/device.service';
import { BottomSheetComponent } from '../bottom-sheet';

/**
 * Singleton panel mounted once at the layout level. Picks its presentation
 * from the active platform:
 *
 *   • TV → absolutely-positioned dropdown anchored to the focused card,
 *     navigated with the D-pad.
 *   • Mobile native → bottom sheet (reuses BottomSheetComponent for swipe-down
 *     dismiss + safe-area handling).
 *
 * The component reads its content from `CardActionsService` and never holds
 * action state itself, so the same instance serves every card on the page.
 */
@Component({
  selector: 'app-card-actions-panel',
  standalone: true,
  imports: [
    TranslateModule,
    BottomSheetComponent,
    LucidePlay,
    LucideExternalLink,
    LucideEye,
    LucideEyeOff,
    LucideTrash2,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './card-actions-panel.html',
  styles: [`
    .card-actions-menu {
      transform-origin: top center;
      animation: card-actions-pop 140ms cubic-bezier(0.2, 0, 0.13, 1.5);
    }
    @keyframes card-actions-pop {
      from { opacity: 0; transform: scale(0.94) translateY(-4px); }
      to   { opacity: 1; transform: scale(1) translateY(0); }
    }
  `],
})
export class CardActionsPanelComponent {
  readonly service = inject(CardActionsService);
  readonly tv = inject(TvService);
  private readonly device = inject(DeviceService);

  readonly menu = viewChild<ElementRef<HTMLElement>>('menu');
  readonly sheet = viewChild<ElementRef<HTMLElement>>('sheet');

  /** Computed style for the anchored dropdown — re-read on each open. */
  readonly position = signal<{ top: number; left: number; width: number } | null>(null);
  /** Index of the currently highlighted action (for keyboard nav). */
  readonly activeIndex = signal(0);

  readonly actions = computed(() => this.service.actions() ?? []);
  readonly title = this.service.title;
  readonly isTv = this.tv.isTv;
  /**
   * Anchored dropdown only on desktop with a mouse. TV and touch surfaces
   * (mobile, tablet) get the bottom-sheet — bigger targets, predictable
   * positioning, and no fragile dropdown anchoring with the body.tv scale
   * transform.
   */
  readonly useDropdown = computed(() => !this.isTv() && !this.device.isTouch());

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    // body.tv applies a scale transform that re-anchors any fixed-position
    // descendant (the bottom sheet) to body's box rather than the viewport.
    // Move the panel host to <html> so its fixed positioning falls back to
    // the viewport while the rest of the page keeps its overscan transform.
    if (this.tv.isTv() && typeof document !== 'undefined') {
      queueMicrotask(() => {
        document.documentElement.appendChild(this.host.nativeElement);
      });
    }
    // Recompute position and reset highlight when the panel opens.
    effect(() => {
      if (!this.service.open()) return;
      this.activeIndex.set(0);
      if (this.useDropdown()) {
        queueMicrotask(() => {
          this.computePosition();
          this.menu()?.nativeElement.querySelector<HTMLButtonElement>('button')?.focus();
        });
      } else if (this.isTv()) {
        // Focus first action so the user can press Enter immediately.
        queueMicrotask(() => {
          this.sheet()?.nativeElement.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
        });
      }
    });
  }

  onClose() {
    this.service.close();
  }

  trigger(action: CardAction) {
    if (action.disabled) return;
    this.service.close();
    // Defer the action so the panel close transition lands first.
    queueMicrotask(() => action.run());
  }

  /**
   * Keyboard handler for the anchored dropdown — Up/Down move highlight,
   * Escape closes. Bound on TV and desktop alike (the bottom sheet on touch
   * surfaces uses tap-to-dismiss instead).
   */
  onMenuKey(e: KeyboardEvent) {
    if (!this.useDropdown()) return;
    const list = this.actions();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      const next = (this.activeIndex() + 1) % list.length;
      this.activeIndex.set(next);
      this.focusActionAt(next);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const prev = (this.activeIndex() - 1 + list.length) % list.length;
      this.activeIndex.set(prev);
      this.focusActionAt(prev);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.onClose();
    }
  }

  private focusActionAt(i: number) {
    const buttons = this.menu()?.nativeElement.querySelectorAll<HTMLButtonElement>('button[data-action]');
    buttons?.[i]?.focus();
  }

  private computePosition() {
    const anchor = this.service.anchor();
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const placement = this.service.placement();
    const margin = placement === 'button' ? 4 : 12;
    // Estimate the panel's height from action count instead of a fixed 320px:
    // a single-action menu is ~120px tall, the old constant overestimated by
    // a factor 3 and forced the panel to render above the anchor even when
    // there was plenty of room below — landing well above the actual card.
    const itemCount = this.actions()?.length ?? 0;
    const titleHeight = this.title() ? 28 : 0;
    const estimatedHeight =
      Math.min(360, 24 + titleHeight + Math.max(itemCount, 1) * 44);
    const fitsBelow = r.bottom + margin + estimatedHeight < window.innerHeight;
    const top = fitsBelow
      ? r.bottom + margin
      : Math.max(8, r.top - estimatedHeight - margin);
    let width: number;
    let left: number;
    if (placement === 'button') {
      // Compact dropdown anchored to the button's right edge — overlays the
      // card body below the ⋯ trigger.
      width = 220;
      left = r.right - width;
    } else {
      // Default: centered under the card figure.
      width = Math.min(280, Math.max(220, r.width));
      left = r.left + (r.width - width) / 2;
    }
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    this.position.set({ top, left, width });
  }
}
