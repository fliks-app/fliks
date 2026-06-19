import { Directive, ElementRef, inject, input, OnDestroy } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { CardAction, CardActionsService } from '../../core/services/card-actions.service';
import { TvService } from '../../core/services/tv.service';

/**
 * Apposed on a card's focusable host (e.g. the `<figure tabindex="0">` of a
 * MediaCard). Wires up the platform-specific gesture that opens the contextual
 * actions panel:
 *
 *   • TV → registers the actions while the host is focused; the service-level
 *     ContextMenu listener does the rest.
 *   • Mobile (native) → registers actions on touchstart, opens the panel after
 *     a 500 ms hold (long-press), and cancels if the finger moves or lifts.
 *   • Web desktop → no-op (cards keep their inline hover overlays).
 *
 * Usage:
 *   ```html
 *   <figure
 *     [appCardActions]="cardActions()"
 *     [actionsTitle]="title()"
 *     tabindex="0"
 *     (click)="open()"
 *   />
 *   ```
 */
@Directive({
  selector: '[appCardActions]',
  standalone: true,
})
export class CardActionsDirective implements OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly service = inject(CardActionsService);
  private readonly tv = inject(TvService);
  private readonly isNativePlatform = Capacitor.isNativePlatform();
  private readonly isMobileNative = this.isNativePlatform && !this.tv.isTv();

  /** Actions to register when this card becomes active. Empty/undefined disables. */
  readonly appCardActions = input<CardAction[] | null | undefined>([]);
  /** Optional title shown atop the panel (typically the card title). */
  readonly actionsTitle = input<string>('');
  /** Optional poster/thumbnail shown in the panel header. */
  readonly actionsImageUrl = input<string | null>(null);
  /** Aspect of the header thumbnail (portrait poster vs landscape still). */
  readonly actionsImageAspect = input<'portrait' | 'landscape'>('portrait');
  /** Optional secondary line under the title in the panel header (e.g. year). */
  readonly actionsSubtitle = input<string>('');

  private longPressTimer: number | null = null;
  private touchStartX = 0;
  private touchStartY = 0;
  private boundHandlers: { type: string; fn: (e: Event) => void }[] = [];

  constructor() {
    if (this.tv.isTv()) {
      this.attach('focus', this.onFocus);
      this.attach('blur', this.onBlur);
    } else if (this.isMobileNative) {
      this.attach('touchstart', this.onTouchStart, { passive: true });
      this.attach('touchend', this.onTouchEnd);
      this.attach('touchcancel', this.onTouchEnd);
      this.attach('touchmove', this.onTouchMove, { passive: true });
      // Suppress the synthetic context menu Android fires after a long-press
      this.attach('contextmenu', this.onContextMenu);
    }
  }

  ngOnDestroy() {
    this.cancelLongPress();
    for (const { type, fn } of this.boundHandlers) {
      this.host.nativeElement.removeEventListener(type, fn);
    }
  }

  private attach(type: string, fn: (e: any) => void, opts?: AddEventListenerOptions) {
    const bound = fn.bind(this) as (e: Event) => void;
    this.host.nativeElement.addEventListener(type, bound, opts);
    this.boundHandlers.push({ type, fn: bound });
  }

  private currentActions(): CardAction[] {
    return (this.appCardActions() ?? []).filter((a) => !!a);
  }

  // ── TV: focus-driven registry ──────────────────────────────────────────
  private onFocus() {
    const actions = this.currentActions();
    if (!actions.length) return;
    this.service.register({
      actions,
      anchor: this.host.nativeElement,
      title: this.actionsTitle(),
      imageUrl: this.actionsImageUrl(),
      imageAspect: this.actionsImageAspect(),
      subtitle: this.actionsSubtitle(),
    });
  }

  private onBlur() {
    this.service.clear(this.host.nativeElement);
  }

  // ── Mobile: long-press ─────────────────────────────────────────────────
  private onTouchStart(e: TouchEvent) {
    const actions = this.currentActions();
    if (!actions.length) return;
    const t = e.touches[0];
    this.touchStartX = t?.clientX ?? 0;
    this.touchStartY = t?.clientY ?? 0;
    this.longPressTimer = window.setTimeout(() => {
      this.service.register({
        actions,
        anchor: this.host.nativeElement,
        title: this.actionsTitle(),
        imageUrl: this.actionsImageUrl(),
        imageAspect: this.actionsImageAspect(),
        subtitle: this.actionsSubtitle(),
      });
      this.service.show();
      this.longPressTimer = null;
    }, 500);
  }

  private onTouchMove(e: TouchEvent) {
    if (this.longPressTimer === null) return;
    const t = e.touches[0];
    if (!t) return;
    if (Math.abs(t.clientX - this.touchStartX) > 10 || Math.abs(t.clientY - this.touchStartY) > 10) {
      this.cancelLongPress();
    }
  }

  private onTouchEnd() {
    this.cancelLongPress();
  }

  private onContextMenu(e: Event) {
    // Suppress browser long-press menu when our panel is going to show
    e.preventDefault();
  }

  private cancelLongPress() {
    if (this.longPressTimer !== null) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }
}
