import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  output,
} from '@angular/core';
import { BottomSheetComponent } from './bottom-sheet';
import { TvService } from '../../core/services/tv.service';
import { DeviceService } from '../../core/services/device.service';

/**
 * Reusable menu chrome that picks its presentation per-platform:
 *   • TV / mobile / tablet (touch) → bottom sheet (BottomSheetComponent).
 *   • Desktop with a mouse → DaisyUI-style anchored dropdown.
 *
 * Usage:
 *   <button #trigger (click)="open.set(!open())">…</button>
 *   <app-popover-menu [open]="open()" [anchor]="trigger" (closed)="open.set(false)">
 *     <ul class="menu p-2">…</ul>
 *   </app-popover-menu>
 *
 * Content is projected via <ng-content>, so every existing menu can keep
 * its template (icons, conditional items, RouterLink) — only the wrapping
 * chrome changes. The bottom-sheet variant carries `data-tv-modal` so the
 * spatial-nav focus trap kicks in.
 */
@Component({
  selector: 'app-popover-menu',
  standalone: true,
  imports: [BottomSheetComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (open()) {
      @if (useDropdown()) {
        <!-- Click-out backdrop (transparent) -->
        <div class="fixed inset-0 z-[100]" (click)="close()"></div>
        <div
          class="fixed z-[101] bg-base-200 rounded-box shadow-xl overflow-hidden"
          [style.top.px]="position().top"
          [style.left.px]="position().left"
          [style.min-width.px]="position().width"
        >
          <ng-content></ng-content>
        </div>
      } @else {
        <app-bottom-sheet [open]="true" (closed)="close()">
          <div data-tv-modal class="px-2 pb-2">
            <ng-content></ng-content>
          </div>
        </app-bottom-sheet>
      }
    }
  `,
})
export class PopoverMenuComponent {
  /** Controlled by the parent. */
  readonly open = input(false);
  /** Element the dropdown should anchor to on desktop. */
  readonly anchor = input<HTMLElement | null>(null);
  /** Where the dropdown opens relative to the anchor. */
  readonly placement = input<'bottom-end' | 'bottom-start' | 'top-end' | 'top-start'>('bottom-end');
  readonly closed = output<void>();

  private readonly tv = inject(TvService);
  private readonly device = inject(DeviceService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    // body.tv applies a scale transform that re-anchors any fixed-position
    // descendant (the bottom sheet) to body's box rather than the viewport.
    // Move the host to <html> so its fixed children fall back to the
    // viewport while the rest of the page keeps its overscan transform.
    if (this.tv.isTv() && typeof document !== 'undefined') {
      queueMicrotask(() => {
        document.documentElement.appendChild(this.host.nativeElement);
      });
    }
    // Focus the first focusable inside the menu on every open. autofocus
    // is unreliable on Capacitor's Android WebView for dynamically added
    // content, so we do it programmatically.
    effect(() => {
      if (!this.open()) return;
      queueMicrotask(() => {
        this.host.nativeElement
          .querySelector<HTMLElement>('a[href], button:not([disabled]), [tabindex="0"]')
          ?.focus({ preventScroll: false });
      });
    });
  }

  /** Anchored dropdown only on desktop with a mouse. TV + touch get the sheet. */
  readonly useDropdown = computed(() => !this.tv.isTv() && !this.device.isTouch());

  /** Recomputed every render. The parent passes anchor by ref so we can
   *  read its bounding box at open time without an explicit signal. */
  readonly position = computed(() => {
    const a = this.anchor();
    if (!a) return { top: 0, left: 0, width: 0 };
    const r = a.getBoundingClientRect();
    const placement = this.placement();
    const onTop = placement.startsWith('top');
    const onEnd = placement.endsWith('end');
    return {
      top: onTop ? r.top - 8 : r.bottom + 8,
      left: onEnd ? r.right - 240 : r.left,
      width: 240,
    };
  });

  close() {
    this.closed.emit();
  }
}
