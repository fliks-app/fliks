import {
  Component,
  ElementRef,
  effect,
  inject,
  viewChild,
} from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { ToastService } from '../../core/services/toast.service';
import {
  LucideCircleCheck,
  LucideCircleX,
  LucideTriangleAlert,
  LucideInfo,
  LucideX,
} from '@lucide/angular';

@Component({
  selector: 'app-toast-container',
  imports: [TranslatePipe, LucideCircleCheck, LucideCircleX, LucideTriangleAlert, LucideInfo, LucideX],
  templateUrl: './toast-container.html',
  styles: [
    `
      /* env(safe-area-inset-*) is 0 on desktop; add a base gap from the edge.
         A stable width keeps the close button pinned right on short messages. */
      .toast {
        inset: auto;
        top: calc(env(safe-area-inset-top, 0px) + 1rem);
        right: calc(env(safe-area-inset-right, 0px) + 1rem);
        width: min(100vw - 2rem, 24rem);
      }
      /* DaisyUI's .alert is a content-sized grid; force a flex row so the text
         (flex-1) pushes the close button to the right edge. */
      .alert {
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }
      /* Strip the popover UA chrome — keep a transparent positioning wrapper. */
      .toast[popover] {
        margin: 0;
        padding: 0;
        border: 0;
        background: transparent;
        overflow: visible;
      }
    `,
  ],
})
export class ToastContainerComponent {
  readonly toastService = inject(ToastService);
  private readonly popover = viewChild<ElementRef<HTMLElement>>('popover');

  constructor() {
    // Top-layer via the Popover API so toasts sit above showModal() <dialog>s,
    // which no z-index can beat; re-promote on each change. Absent API (older TV
    // webviews) falls back to the z-index div.
    effect(() => {
      const hasToasts = this.toastService.toasts().length > 0;
      const el = this.popover()?.nativeElement;
      if (!el || typeof el.showPopover !== 'function') return;
      const open = el.matches(':popover-open');
      if (hasToasts) {
        if (open) el.hidePopover();
        el.showPopover();
      } else if (open) {
        el.hidePopover();
      }
    });
  }
}
