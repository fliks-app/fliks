import { Injectable, computed, effect, inject, signal, type Signal } from '@angular/core';
import { DeviceService } from '../../../core/services/device.service';
import { desktopBridgeOrNull } from '../../../core/plugins/desktop-player.bridge';

const HIDE_DELAY_TV_MS = 5000;
const HIDE_DELAY_MS = 3000;

/** Owns whether the player's controls are on screen: auto-hide countdown, suspending pins and the cursor; provided per player. */
@Injectable()
export class ControlsVisibilityService {
  private readonly device = inject(DeviceService);

  /** Starts up: the viewer is looking at a paused or loading frame. */
  readonly visible = signal(true);
  /** The reaction row alone, raised by ArrowDown on a hidden bar; the controls stay down. */
  readonly reactionsOnly = signal(false);
  /** Reduced to the seekbar, raised by an arrow-key seek. Survives a hide so
   *  the full bar does not remount during the fade-out. */
  readonly seekOsd = signal(false);
  /** A press the bar must outlive (push-to-talk): the countdown waits for the release. */
  readonly holding = signal(false);
  /** A dropdown or bottom sheet inside the controls is open. */
  private readonly panelOpen = signal(false);

  /** Bumped by any interaction that should restart the countdown. */
  private readonly activity = signal(0);
  private pinned: Signal<boolean> = computed(() => false);

  /** `pinned` names the states that must keep the bar up: paused, buffering,
   *  a drag in flight. An open panel is tracked here. */
  configure(options: { pinned?: Signal<boolean> } = {}): void {
    if (options.pinned) this.pinned = options.pinned;
  }

  show(seekOsd = false): void {
    this.seekOsd.set(seekOsd);
    this.reactionsOnly.set(false);
    this.visible.set(true);
    this.resetHideTimer();
  }

  showReactions(): void {
    this.visible.set(false);
    this.reactionsOnly.set(true);
    this.resetHideTimer();
  }

  /** Focus stays on the hidden button, so a key wakes the bar where the viewer left it; the players'
   *  key handlers turn that key into a wake instead of pressing the invisible button. */
  hide(): void {
    this.visible.set(false);
    this.reactionsOnly.set(false);
  }

  /** A tap on the surface. An open dropdown swallows it so the bar stays. */
  toggle(): void {
    if (this.reactionsOnly() || (this.visible() && !this.dropdownOpen())) this.hide();
    else this.show();
  }

  /** Restart the countdown without changing what is shown. */
  resetHideTimer(): void {
    this.activity.update((n) => n + 1);
  }

  /** Focus moved inside the bar. Ignored while hidden, or a focus change would re-arm the countdown forever. */
  onInteraction(): void {
    if (this.visible() || this.reactionsOnly()) this.resetHideTimer();
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
    const reactions = this.reactionsOnly();
    if (this.holding() || (!reactions && (!this.visible() || this.pinned() || this.panelOpen()))) return;
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
