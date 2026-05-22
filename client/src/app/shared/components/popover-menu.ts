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
import { NgTemplateOutlet } from '@angular/common';
import { BottomSheetComponent } from './bottom-sheet';
import { TvService } from '../../core/services/tv.service';
import { DeviceService } from '../../core/services/device.service';
import { DismissableStackService } from '../../core/services/dismissable-stack.service';

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
  imports: [BottomSheetComponent, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- Capture projected content in a template ref so it can be rendered
         in either the dropdown or sheet branch without hitting the
         "ng-content inside @if doesn't project" issue. The <ng-template>
         itself never renders; *ngTemplateOutlet does. -->
    <ng-template #content><ng-content></ng-content></ng-template>

    @if (open() && useDropdown()) {
      <!-- Click-out backdrop (transparent) -->
      <div class="fixed inset-0 z-[100]" (click)="close()"></div>
      <div
        data-tv-modal
        class="fixed z-[101] bg-base-200 rounded-box shadow-xl overflow-y-auto p-2 [scroll-padding:0.5rem] [scroll-behavior:smooth]"
        [style.top.px]="position().top"
        [style.left.px]="position().left"
        [style.min-width.px]="position().width"
        [style.max-height.px]="position().maxHeight"
      >
        <ng-container *ngTemplateOutlet="content"></ng-container>
      </div>
    } @else if (open() && !useDropdown()) {
      <app-bottom-sheet [open]="true" (closed)="close()">
        <div data-tv-modal class="px-2 pb-2">
          <ng-container *ngTemplateOutlet="content"></ng-container>
        </div>
      </app-bottom-sheet>
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
  private readonly dismissStack = inject(DismissableStackService);

  constructor() {
    // Move the host to <html> on every platform that renders the sheet
    // variant. Two separate problems both need this:
    //   • TV → body.tv has a scale transform that re-anchors fixed
    //     descendants to body's box instead of the viewport.
    //   • Mobile → the layout's drawer-content is `position: relative`,
    //     creating a stacking context that traps z-[101] below the
    //     bottom dock (z-40 at body level).
    // Hosting under <html> escapes both.
    if (typeof document !== 'undefined' && !this.useDropdown()) {
      queueMicrotask(() => {
        document.documentElement.appendChild(this.host.nativeElement);
      });
    }
    // Focus the first focusable inside the menu on every open. autofocus
    // is unreliable on Capacitor's Android WebView for dynamically added
    // content, so we do it programmatically.
    effect((onCleanup) => {
      if (!this.open()) return;
      queueMicrotask(() => {
        // Prefer the active item (caller marks it with `[autofocus]` or
        // `[aria-current]`) so the user lands on the current selection
        // instead of having to scroll through the list. Falls back to the
        // first focusable when nothing's marked active.
        const root = this.host.nativeElement;
        const target =
          root.querySelector<HTMLElement>('[autofocus]:not([disabled])') ??
          root.querySelector<HTMLElement>('[aria-current="true"]:not([disabled])') ??
          root.querySelector<HTMLElement>('a[href], button:not([disabled]), [tabindex="0"]');
        target?.focus({ preventScroll: false });
        target?.scrollIntoView({ block: 'nearest', behavior: 'instant' as ScrollBehavior });
      });
      // Register with the dismissable stack so Escape (browser) and the
      // hardware back button (Capacitor / Tizen) close the popover.
      const close = () => this.close();
      this.dismissStack.push(close);
      onCleanup(() => this.dismissStack.remove(close));
    });
  }

  /** Anchored dropdown only on desktop with a mouse. TV + touch get the sheet. */
  readonly useDropdown = computed(() => !this.tv.isTv() && !this.device.isTouch());

  /** Recomputed every render. The parent passes anchor by ref so we can
   *  read its bounding box at open time without an explicit signal.
   *  `maxHeight` is capped to the available space between the popover's
   *  edge and the viewport edge so a long list doesn't overflow off-screen
   *  (the internal `overflow-y-auto` only scrolls content INSIDE the box,
   *  it doesn't help when the box itself is taller than the viewport). */
  readonly position = computed(() => {
    const a = this.anchor();
    if (!a) return { top: 0, left: 0, width: 0, maxHeight: 0 };
    const r = a.getBoundingClientRect();
    const placement = this.placement();
    const onTop = placement.startsWith('top');
    const onEnd = placement.endsWith('end');
    const GUTTER = 8;
    const viewportH = typeof window !== 'undefined' ? window.innerHeight : 800;
    const maxHeight = onTop ? r.top - GUTTER * 2 : viewportH - r.bottom - GUTTER * 2;
    return {
      top: onTop ? r.top - GUTTER : r.bottom + GUTTER,
      left: onEnd ? r.right - 240 : r.left,
      width: 240,
      maxHeight: Math.max(120, maxHeight),
    };
  });

  close() {
    this.closed.emit();
  }
}
