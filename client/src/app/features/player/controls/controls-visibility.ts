import { Injectable, computed, effect, inject, signal, type Signal } from '@angular/core';
import { DeviceService } from '../../../core/services/device.service';
import { desktopBridgeOrNull } from '../../../core/plugins/desktop-player.bridge';

const HIDE_DELAY_TV_MS = 5000;
const HIDE_DELAY_MS = 3000;

/**
 * Owns whether a player's controls are on screen: the auto-hide countdown, the
 * pins that suspend it, the blur so a hidden button cannot be pressed, and the
 * cursor. Provided per player component, never app-wide.
 */
@Injectable()
export class ControlsVisibilityService {
  private readonly device = inject(DeviceService);

  /** Starts up: the viewer is looking at a paused or loading frame. */
  readonly visible = signal(true);
  /** Reduced to the seekbar, raised by an arrow-key seek. Survives a hide so
   *  the full bar does not remount during the fade-out. */
  readonly seekOsd = signal(false);
  /** A dropdown or bottom sheet inside the controls is open. */
  private readonly panelOpen = signal(false);

  /** Bumped by any interaction that should restart the countdown. */
  private readonly activity = signal(0);
  private pinned: Signal<boolean> = computed(() => false);
  /** The controls element to blur out of when hiding. */
  private surfaceSelector = 'app-player-controls';

  /** `pinned` names the states that must keep the bar up: paused, buffering,
   *  a drag in flight. An open panel is tracked here. */
  configure(options: { pinned?: Signal<boolean>; surfaceSelector?: string } = {}): void {
    if (options.pinned) this.pinned = options.pinned;
    if (options.surfaceSelector) this.surfaceSelector = options.surfaceSelector;
  }

  show(seekOsd = false): void {
    this.seekOsd.set(seekOsd);
    this.visible.set(true);
    this.resetHideTimer();
  }

  hide(): void {
    this.visible.set(false);
    // Or the next OK on a remote presses a button nobody can see, the back
    // arrow being the likeliest one. A floating cue outlives the bar and keeps focus.
    const active = document.activeElement as HTMLElement | null;
    if (active?.closest(this.surfaceSelector) && !active.closest('.player-floating-cue')) active.blur();
  }

  /** A tap on the surface. An open dropdown swallows it so the bar stays. */
  toggle(): void {
    if (this.visible() && !this.dropdownOpen()) this.hide();
    else this.show();
  }

  /** Restart the countdown without changing what is shown. */
  resetHideTimer(): void {
    this.activity.update((n) => n + 1);
  }

  /** Focus moved inside the bar. Ignored while hidden: the hide itself blurs,
   *  and whatever picks the focus up next would re-arm the countdown forever. */
  onInteraction(): void {
    if (this.visible()) this.resetHideTimer();
  }

  onPanelOpenChange(open: boolean): void {
    this.panelOpen.set(open);
    if (open) this.visible.set(true);
    else this.resetHideTimer();
  }

  /** Pointer movement wakes the bar, except where the pointer is a fiction:
   *  a touch screen sends a move before every tap, and a D-pad drifts. */
  onPointerMove(): void {
    if (this.device.isTouch() || this.device.isDpad()) return;
    this.show();
  }

  /** A webOS Magic Remote sends wheel and click, never keydown, so those
   *  discrete gestures wake the bar even though pointer moves do not. */
  wakeFromPointerGesture(): void {
    if (this.device.isDpad() && !this.visible()) this.show();
  }

  private dropdownOpen(): boolean {
    // daisyUI dropdowns open on focus-within, so the active element tells.
    return this.panelOpen() || !!document.activeElement?.closest('.dropdown');
  }

  private readonly autoHide = effect((onCleanup) => {
    if (!this.visible() || this.pinned() || this.panelOpen()) return;
    this.activity();
    const delay = this.device.isTv() ? HIDE_DELAY_TV_MS : HIDE_DELAY_MS;
    const id = setTimeout(() => this.hide(), delay);
    onCleanup(() => clearTimeout(id));
  });

  /** The page cursor is CSS, but where the surface is the native compositor's
   *  window the pointer belongs to it and has to be told separately. */
  private readonly nativeCursor = effect(() => {
    const visible = this.visible();
    void desktopBridgeOrNull()
      ?.setCursorVisible(visible)
      .catch(() => {});
  });
}
