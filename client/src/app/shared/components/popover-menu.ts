import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
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
  // `display: contents` keeps the host out of its parent's layout — the
  // backdrop + content divs are `position: fixed` so they don't need a
  // box of their own, and the host would otherwise act as a stray grid
  // item inside a parent like daisyUI's `.modal` (display: grid;
  // place-items: center) and shift the modal-box off-centre.
  styles: [':host { display: contents; }'],
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
        [style.bottom.px]="position().bottom"
        [style.left.px]="position().left"
        [style.min-width.px]="position().width"
        [style.max-height.px]="position().maxHeight"
      >
        <ng-container *ngTemplateOutlet="content"></ng-container>
      </div>
    }
    @if (!useDropdown()) {
      <!-- Kept mounted so [open]->false plays the sheet's slide-down exit.
           The sheet gates <ng-content> behind its own @if(visible()), so the
           projected content (and its bindings) is only instantiated while the
           sheet is on screen — safe to leave the outlet unguarded here. -->
      <app-bottom-sheet [open]="open()" (closed)="close()">
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

  /** Ticked on every scroll / resize while the popover is open so the
   *  `position()` computed re-reads the anchor's `getBoundingClientRect`
   *  and the `position: fixed` box stays glued to the trigger. */
  private readonly viewportTick = signal(0);
  /** True once the host has been moved out of its Angular-owned position. */
  private reparented = false;

  constructor() {
    // The host is moved under <html>/the open dialog's top-layer on open (see
    // the open effect below), so Angular no longer owns its DOM position and
    // won't remove the relocated node on destroy. Detach it ourselves —
    // otherwise a popover torn down mid-close (its sheet's slide-down exit
    // still running) orphans the sheet's full-screen backdrop, which keeps
    // blocking clicks across the app.
    inject(DestroyRef).onDestroy(() => {
      if (this.reparented) this.host.nativeElement.remove();
    });

    // Focus the first focusable inside the menu on every open. autofocus
    // is unreliable on Capacitor's Android WebView for dynamically added
    // content, so we do it programmatically.
    effect((onCleanup) => {
      if (!this.open()) return;
      // Move the host on every open so we land in the right stacking
      // context for the *current* anchor. Three problems we sidestep:
      //   • <dialog open> → showModal() renders in the browser top-layer,
      //     which sits above every regular z-index. The popover host can
      //     be mounted anywhere (e.g. the SelectPicker singleton lives
      //     at the app root, not inside the dialog), so we walk up from
      //     the anchor — not the host — to find the open dialog and
      //     append into its top-layer.
      //   • TV → body.tv has a scale transform that re-anchors fixed
      //     descendants to body's box instead of the viewport.
      //   • Mobile → drawer-content is `position: relative`, creating a
      //     stacking context that traps z-[101] below the bottom dock.
      // When no dialog is open we relocate to <html> unconditionally
      // (dropdown variant included) so a previous dialog-scoped open
      // doesn't leave the host orphaned inside a now-closed dialog.
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

      // Re-tick on scroll / resize so the `position()` computed
      // re-reads `getBoundingClientRect` and the fixed-positioned box
      // stays glued to its trigger. `capture: true` catches scrolls in
      // any nested overflow container, not just window.
      if (typeof window === 'undefined' || !this.useDropdown()) return;
      const tick = () => this.viewportTick.update((v) => v + 1);
      window.addEventListener('scroll', tick, { capture: true, passive: true });
      window.addEventListener('resize', tick);
      onCleanup(() => {
        window.removeEventListener('scroll', tick, { capture: true } as never);
        window.removeEventListener('resize', tick);
      });
    });
  }

  /** Anchored dropdown only on desktop with a mouse. TV + touch get the sheet. */
  readonly useDropdown = computed(() => !this.tv.isTv() && !this.device.isTouch());

  /** Re-reads `getBoundingClientRect` on every anchor change AND on every
   *  viewport tick (scroll / resize) so the fixed-positioned box follows its
   *  trigger when the page moves under it. The box is kept inside the viewport
   *  on both axes: vertically it opens on the requested side but flips to the
   *  other when that side can't fit a usable menu (so a tall list near the
   *  bottom edge doesn't spill off-screen), anchoring with `bottom` when it
   *  opens upward; horizontally `left` is clamped into the viewport. The
   *  chosen side's free space caps `maxHeight`, and the internal
   *  `overflow-y-auto` scrolls the content INSIDE the box. */
  readonly position = computed(() => {
    this.viewportTick(); // dependency: forces recompute on scroll / resize
    const GUTTER = 8;
    const WIDTH = 240;
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

    // Vertical: open on the requested side, but flip when it can't hold a
    // usable menu and the other side has more room.
    const spaceBelow = viewportH - r.bottom - GUTTER * 2;
    const spaceAbove = r.top - GUTTER * 2;
    const openTop = wantTop
      ? !(spaceAbove < MIN_HEIGHT && spaceBelow > spaceAbove)
      : spaceBelow < MIN_HEIGHT && spaceAbove > spaceBelow;
    const maxHeight = Math.max(MIN_HEIGHT, openTop ? spaceAbove : spaceBelow);

    // Horizontal: anchor to the requested edge, then clamp into the viewport.
    const rawLeft = onEnd ? r.right - WIDTH : r.left;
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
}
