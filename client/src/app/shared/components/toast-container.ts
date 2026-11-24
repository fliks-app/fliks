import {
  Component,
  ElementRef,
  effect,
  inject,
  viewChild,
} from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { ToastService } from '../../core/services/toast.service';
import { LucideDynamicIcon } from '@lucide/angular';
import { icons } from '../icons';

@Component({
  selector: 'app-toast-container',
  imports: [TranslatePipe, LucideDynamicIcon],
  templateUrl: './toast-container.html',
  styles: [
    `
      .toast {
        inset: auto;
        top: calc(env(safe-area-inset-top, 0px) + 1rem);
        right: calc(env(safe-area-inset-right, 0px) + 1rem);
        align-items: flex-end;
        width: min(100vw - 2rem, 26rem);
        pointer-events: none;
        --toast-from: translateY(-0.75rem);
      }
      /* Phones: centred above the dock and the mini-bars (layout publishes --chrome-bottom-total). */
      @media (max-width: 767px) {
        .toast {
          top: auto;
          right: 0;
          left: 0;
          bottom: var(--chrome-bottom-total, calc(env(safe-area-inset-bottom, 0px) + 1rem));
          margin-inline: auto;
          align-items: center;
          --toast-from: translateY(0.75rem);
        }
      }
      .toast[popover] {
        margin-block: 0;
        padding: 0;
        border: 0;
        background: transparent;
        overflow: visible;
      }
      .toast-pill {
        pointer-events: auto;
        display: flex;
        align-items: center;
        gap: 0.625rem;
        width: fit-content;
        max-width: 100%;
        padding: 0.5rem 0.5rem 0.5rem 1rem;
        border-radius: 0.875rem;
        border: 0;
        box-shadow: 0 10px 30px -8px rgb(0 0 0 / 0.5);
        color: #1a1a1a;
        animation: none;
      }
      .toast-pill.alert-error {
        --alert-color: #f87171;
      }
      .toast-pill.alert-success {
        --alert-color: #3ecf8e;
      }
      .toast-pill.alert-info {
        --alert-color: #60a5fa;
      }
      .toast-pill.alert-warning {
        --alert-color: #fbbf24;
      }
      .toast-pill--tall {
        align-items: flex-start;
        padding: 0.875rem 0.75rem 0.875rem 1rem;
        border-radius: 1rem;
      }
      @media (prefers-reduced-motion: no-preference) {
        .toast-in {
          animation: toast-in 320ms cubic-bezier(0.2, 0.9, 0.3, 1.2);
        }
        .toast-out {
          animation: toast-out 200ms cubic-bezier(0.4, 0, 1, 1) forwards;
        }
      }
      @keyframes toast-in {
        from {
          opacity: 0;
          transform: var(--toast-from) scale(0.92);
        }
      }
      @keyframes toast-out {
        to {
          opacity: 0;
          transform: scale(0.92);
        }
      }
    `,
  ],
})
export class ToastContainerComponent {
  protected readonly icons = icons;

  readonly toastService = inject(ToastService);
  private readonly popover = viewChild<ElementRef<HTMLElement>>('popover');

  constructor() {
    // Top layer via the Popover API so toasts sit above showModal() dialogs (no z-index can); falls back to the z-index div on older TV webviews.
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
