import {
  Component,
  DestroyRef,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { BottomSheetComponent } from './bottom-sheet';
import { TvService } from '../../core/services/tv.service';
import { DeviceService } from '../../core/services/device.service';
import { DismissableStackService } from '../../core/services/dismissable-stack.service';
import {
  focusOverlayEntry,
  initialOverlayFocus,
  restoreOpenerFocus,
} from '../../core/services/focusable.constants';

/** Menu chrome: bottom sheet on TV/touch, anchored dropdown on desktop with a mouse; content is projected.
 * The sheet carries `data-tv-modal` so the spatial-nav focus trap kicks in. */
@Component({
  selector: 'app-popover-menu',
  standalone: true,
  imports: [BottomSheetComponent, NgTemplateOutlet],
  // `display: contents` keeps the host from acting as a stray grid item (e.g. in daisyUI's `.modal`) and off-centring it.
  styles: [':host { display: contents; }'],
  templateUrl: './popover-menu.html',
})
export class PopoverMenuComponent {
  /** Controlled by the parent. */
  readonly open = input(false);
  /** Element the dropdown should anchor to on desktop. */
  readonly anchor = input<HTMLElement | null>(null);
  /** Where the dropdown opens: `*-center` under the anchor, `right-start`/`left-start` side flyouts for submenus, `start-end` overlaying it. */
  readonly placement = input<
    | 'bottom-end'
    | 'bottom-start'
    | 'bottom-center'
    | 'top-end'
    | 'top-start'
    | 'right-start'
    | 'left-start'
    | 'start-end'
  >('bottom-end');
  /** Dropdown width in px (the sheet ignores it). */
  readonly width = input(240);
  /** Title rendered above the content, in both the dropdown and the sheet. */
  readonly heading = input('');
  /** Marks this menu as a flyout submenu: spatial nav traps up/down inside it
   *  and lets left/right return to the opener in the parent menu. */
  readonly submenu = input(false);
  readonly closed = output<void>();

  private readonly tv = inject(TvService);
  private readonly device = inject(DeviceService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly dismissStack = inject(DismissableStackService);

  /** Ticked on scroll/resize while open so `position()` re-reads the anchor rect. */
  private readonly viewportTick = signal(0);
  /** True once the host has been moved out of its Angular-owned position. */
  private reparented = false;

  constructor() {
    // The host is relocated on open, so Angular won't remove it on destroy; detach it or a mid-close sheet orphans its blocking backdrop.
    inject(DestroyRef).onDestroy(() => {
      if (this.reparented) this.host.nativeElement.remove();
    });

    // Programmatic focus: autofocus is unreliable on Capacitor's Android WebView for dynamically added content.
    effect((onCleanup) => {
      if (!this.open()) return;
      // Relocate on every open into the right stacking context for the current anchor:
      // a showModal() dialog's top-layer (found from the anchor, not the host), else <html>; body.tv scale and mobile drawer stacking contexts trap fixed boxes.
      if (typeof document !== 'undefined') {
        const anchor = this.anchor();
        const openDialog =
          anchor?.closest<HTMLDialogElement>('dialog[open]') ?? null;
        const target = openDialog ?? document.documentElement;
        if (this.host.nativeElement.parentElement !== target) {
          target.appendChild(this.host.nativeElement);
          this.reparented = true;
        }
      }
      queueMicrotask(() => {
        // Record the opener so spatial nav returns focus to it on ArrowLeft instead of what sits behind the flyout.
        if (this.submenu()) {
          const content = this.host.nativeElement.querySelector<HTMLElement>(
            '[data-tv-submenu]',
          );
          if (content) {
            (content as unknown as { __tvOpener?: HTMLElement | null }).__tvOpener =
              this.anchor();
          }
        }
        // Land on the current selection rather than making the user scroll to
        // it; falls back to the first focusable when nothing is marked.
        focusOverlayEntry(initialOverlayFocus(this.host.nativeElement));
      });
      // Register with the dismissable stack (Escape / hardware back) and return focus to the opener (submenu: parent entry).
      const anchorOf = () => untracked(() => this.anchor());
      const bump = () => this.viewportTick.update((v) => v + 1);
      const close = () => {
        restoreOpenerFocus(this.anchor());
        this.close();
      };
      this.dismissStack.push(close);
      onCleanup(() => this.dismissStack.remove(close));

      // Follow the anchor per frame, not per event: nested scroll containers, transforms and late reflows move it without a `scroll`/`resize`.
      // The tick bumps only when the rect changed, so an idle menu schedules no change detection.
      if (typeof window === 'undefined' || !this.useDropdown()) return;
      let previous = '';
      let frame = requestAnimationFrame(function follow(this: void) {
        const a = anchorOf();
        const r = a?.getBoundingClientRect();
        const current = r ? `${r.top}|${r.left}|${r.width}|${r.height}` : '';
        if (current !== previous) {
          previous = current;
          bump();
        }
        frame = requestAnimationFrame(follow);
      });
      onCleanup(() => cancelAnimationFrame(frame));
    });
  }

  /** Anchored dropdown only on desktop with a mouse. TV + touch get the sheet. */
  readonly useDropdown = computed(() => !this.tv.isTv() && !this.device.isTouch());

  /** Re-reads the anchor rect on anchor change and viewport tick, keeping the box inside the viewport.
   * It flips side when the requested one can't fit a usable menu, and its free space caps `maxHeight`. */
  readonly position = computed(() => {
    this.viewportTick(); // dependency: forces recompute on scroll / resize
    const GUTTER = 8;
    const WIDTH = this.width();
    const MIN_HEIGHT = 120;
    const a = this.anchor();
    if (!a)
      return { top: 0 as number | null, bottom: null as number | null, left: 0, width: 0, maxHeight: 0 };
    const r = a.getBoundingClientRect();
    const placement = this.placement();
    const wantTop = placement.startsWith('top');
    const onEnd = placement.endsWith('end');
    const viewportH = typeof window !== 'undefined' ? window.innerHeight : 800;
    const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1280;

    // Side flyout (submenu): open beside the anchor, top-aligned; flip to the
    // other side when the preferred one can't fit the menu width.
    if (placement === 'right-start' || placement === 'left-start') {
      const rightLeft = r.right + GUTTER;
      const leftLeft = r.left - WIDTH - GUTTER;
      const fitsRight = rightLeft + WIDTH <= viewportW - GUTTER;
      const fitsLeft = leftLeft >= GUTTER;
      const preferRight = placement === 'right-start';
      let left = preferRight
        ? fitsRight || !fitsLeft
          ? rightLeft
          : leftLeft
        : fitsLeft || !fitsRight
          ? leftLeft
          : rightLeft;
      left = Math.min(
        Math.max(GUTTER, left),
        Math.max(GUTTER, viewportW - WIDTH - GUTTER),
      );
      const top = Math.min(
        Math.max(GUTTER, r.top),
        Math.max(GUTTER, viewportH - MIN_HEIGHT - GUTTER),
      );
      return {
        top,
        bottom: null as number | null,
        left,
        width: WIDTH,
        maxHeight: Math.max(MIN_HEIGHT, viewportH - top - GUTTER),
      };
    }

    // Overlay drop: top edge just under the anchor's top, right edges flush,
    // so a trigger low in the anchor still opens the menu from its top.
    if (placement === 'start-end') {
      const INSET = 10;
      const top = Math.min(
        Math.max(GUTTER, r.top + INSET),
        Math.max(GUTTER, viewportH - MIN_HEIGHT - GUTTER),
      );
      const left = Math.min(
        Math.max(GUTTER, r.right - WIDTH),
        Math.max(GUTTER, viewportW - WIDTH - GUTTER),
      );
      return {
        top,
        bottom: null as number | null,
        left,
        width: WIDTH,
        maxHeight: Math.max(MIN_HEIGHT, viewportH - top - GUTTER),
      };
    }

    // Vertical: open on the requested side, but flip when it can't hold a
    // usable menu and the other side has more room.
    const spaceBelow = viewportH - r.bottom - GUTTER * 2;
    const spaceAbove = r.top - GUTTER * 2;
    const openTop = wantTop
      ? !(spaceAbove < MIN_HEIGHT && spaceBelow > spaceAbove)
      : spaceBelow < MIN_HEIGHT && spaceAbove > spaceBelow;
    const maxHeight = Math.max(MIN_HEIGHT, openTop ? spaceAbove : spaceBelow);

    // Horizontal: anchor to the requested edge (or centre), then clamp.
    const rawLeft = placement.endsWith('center')
      ? r.left + (r.width - WIDTH) / 2
      : onEnd
        ? r.right - WIDTH
        : r.left;
    const left = Math.min(
      Math.max(GUTTER, rawLeft),
      Math.max(GUTTER, viewportW - WIDTH - GUTTER),
    );

    return {
      top: openTop ? null : r.bottom + GUTTER,
      bottom: openTop ? viewportH - r.top + GUTTER : null,
      left,
      width: WIDTH,
      maxHeight,
    };
  });

  close() {
    this.closed.emit();
  }

  /** A submenu closes once focus leaves it, so re-activating the opener re-opens and re-focuses it. */
  protected onSubmenuFocusOut(e: FocusEvent): void {
    if (!this.submenu()) return;
    const next = e.relatedTarget as Node | null;
    if (next && this.host.nativeElement.contains(next)) return;
    this.close();
  }
}
