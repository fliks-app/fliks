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
})
export class CardActionsPanelComponent {
  readonly service = inject(CardActionsService);
  readonly tv = inject(TvService);

  readonly menu = viewChild<ElementRef<HTMLElement>>('menu');

  /** Computed style for the TV anchored dropdown — re-read on each open. */
  readonly position = signal<{ top: number; left: number; width: number } | null>(null);
  /** Index of the currently highlighted action (for D-pad keyboard nav). */
  readonly activeIndex = signal(0);

  readonly actions = computed(() => this.service.actions() ?? []);
  readonly title = this.service.title;
  readonly isTv = this.tv.isTv;

  constructor() {
    // Recompute position and reset highlight when the panel opens.
    effect(() => {
      if (!this.service.open()) return;
      this.activeIndex.set(0);
      if (this.isTv()) {
        queueMicrotask(() => {
          this.computePosition();
          this.menu()?.nativeElement.querySelector<HTMLButtonElement>('button')?.focus();
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

  /** Keyboard handler for the TV dropdown — Up/Down move highlight, Enter activates. */
  onMenuKey(e: KeyboardEvent) {
    if (!this.isTv()) return;
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
    const margin = 12;
    const width = Math.min(280, Math.max(220, r.width));
    // Default below the card; flip above when there isn't enough room.
    const fitsBelow = r.bottom + 320 < window.innerHeight;
    const top = fitsBelow ? r.bottom + margin : r.top - 320 - margin;
    let left = r.left + (r.width - width) / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    this.position.set({ top, left, width });
  }
}
