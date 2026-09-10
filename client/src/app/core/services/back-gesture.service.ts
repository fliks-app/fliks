import { Injectable, effect, inject, signal } from '@angular/core';
import { NavigationEnd, NavigationStart, Router } from '@angular/router';
import { filter, take } from 'rxjs';
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { CastPlayerService } from './cast-player.service';
import { DismissableStackService } from './dismissable-stack.service';
import { NavbarService } from './navbar.service';
import { remoteOverlayOpen } from './remote-playback-target';
import { setSwipeBackActive } from '../../shared/utils/view-transition';

interface BackGesturePlugin {
  setEnabled(options: { enabled: boolean }): Promise<void>;
  settled(): Promise<void>;
  captureCandidate(): Promise<void>;
  settle(options: { delta: number }): Promise<void>;
  addListener(
    event: 'end',
    callback: (data: { commit?: boolean }) => void,
  ): Promise<PluginListenerHandle>;
}

const BackGesture = registerPlugin<BackGesturePlugin>('BackGesture');

/** Routes the gesture stays out of. The player owns the whole screen and has
 *  its own back; the settings, account and admin shells navigate between their
 *  own panels, where sliding the entire screen off reads as leaving the app. */
const UNSWIPEABLE = ['/watch', '/admin', '/account', '/app-settings'];

/** Above this a frame belongs to the rebuild, which lands them 60-80 ms apart
 *  where a page at rest paces at 8-17 ms. */
const SMOOTH_FRAME_MS = 24;

/**
 * iOS left-edge swipe-back. The recognizer and the slide animation live in
 * BackGesturePlugin.swift; this side decides when the gesture is armed and
 * runs the app's own back on commit.
 *
 * Arming is a signal effect rather than a check at gesture time: the native
 * recognizer has to be off *before* the touch, or it swallows the pan that
 * belongs to a carousel or an open sheet.
 *
 * It also feeds the native side a snapshot of every page left behind, so the
 * swipe can slide the current page off the one it is returning to. The stack
 * is kept aligned by mirroring NavbarService's own depth: replaced URLs,
 * query-only changes and the player's back all decide differently there, and
 * re-deriving those rules here would drift.
 */
@Injectable({ providedIn: 'root' })
export class BackGestureService {
  private readonly router = inject(Router);
  private readonly navbar = inject(NavbarService);
  private readonly dismissStack = inject(DismissableStackService);
  private readonly castPlayer = inject(CastPlayerService);

  private readonly available = Capacitor.getPlatform() === 'ios';
  private readonly url = signal(this.router.url);
  private listener?: PluginListenerHandle;
  private enabled = true;
  /** Back-stack depth at the last NavigationEnd. goBack() pops before it
   *  navigates, so a start-of-navigation reading already shows the pop. */
  private lastDepth = 0;
  /** Resolves when the pending capture has been stored. settle() consumes the
   *  candidate, and a fast navigation reaches its end before the snapshot
   *  comes back. */
  private capturing: Promise<unknown> = Promise.resolve();

  private readonly armEffect = effect(() => {
    const url = this.url();
    const enabled =
      this.navbar.canGoBack() &&
      !UNSWIPEABLE.some((prefix) => url.startsWith(prefix)) &&
      !this.dismissStack.hasAny() &&
      !this.castPlayer.expanded() &&
      !remoteOverlayOpen();
    if (!this.available || enabled === this.enabled) return;
    this.enabled = enabled;
    void BackGesture.setEnabled({ enabled }).catch(() => {});
  });

  constructor() {
    if (!this.available) return;
    this.router.events.subscribe((e) => {
      if (e instanceof NavigationStart) {
        // A query-only change is in-page state (library tabs, filters); the
        // navbar doesn't push one, so there is nothing to capture.
        if (this.pathOf(e.url) !== this.pathOf(this.url())) {
          this.capturing = BackGesture.captureCandidate().catch(() => {});
        }
      }
      if (e instanceof NavigationEnd) {
        this.url.set(e.urlAfterRedirects);
        const depth = this.navbar.backDepth;
        const delta = depth - this.lastDepth;
        this.lastDepth = depth;
        void this.capturing.then(() => BackGesture.settle({ delta })).catch(() => {});
      }
    });
  }

  /** `onCommit` is the app's shared back path, so the gesture closes layers
   *  and leaves the player exactly like the Android hardware button. */
  init(onCommit: () => void): void {
    if (!this.available) return;
    void BackGesture.addListener('end', ({ commit }) => {
      if (!commit) return;
      setSwipeBackActive(true);
      this.releaseTransitionsOnArrival();
      onCommit();
      this.reportSettled();
    }).then((handle) => {
      this.listener = handle;
    });
  }

  /**
   * Tells the native side when the page it navigated to has stopped rebuilding.
   *
   * A cached page comes back with its rows re-rendered, and on a slower device
   * that rebuild runs for a few hundred milliseconds, painting half-filled
   * frames along the way. Frame pacing is the signal for it: while the rebuild
   * runs, frames land 60-80 ms apart, and two in a row at screen rate mean it
   * is over. The snapshot held until then is the destination's own, so the
   * wait shows nothing the viewer would not see anyway.
   */
  private reportSettled(): void {
    const start = performance.now();
    let previous = start;
    let smooth = 0;
    const tick = (now: number) => {
      if (now - previous <= SMOOTH_FRAME_MS) smooth++;
      else smooth = 0;
      previous = now;
      // The native side drops the overlay on its own past its own deadline.
      if (smooth >= 2 || now - start > 900) {
        void BackGesture.settled().catch(() => {});
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  private pathOf(url: string): string {
    return url.split(/[?#]/)[0];
  }

  /** Back doesn't always navigate — it may have closed a layer instead — so the
   *  flag is released on a timer too, or one such gesture would disable every
   *  later view transition. */
  private releaseTransitionsOnArrival(): void {
    const subscription = this.router.events
      .pipe(
        filter((e): e is NavigationEnd => e instanceof NavigationEnd),
        take(1),
      )
      .subscribe(() => setTimeout(() => setSwipeBackActive(false)));
    setTimeout(() => {
      subscription.unsubscribe();
      setSwipeBackActive(false);
    }, 1000);
  }

  destroy(): void {
    void this.listener?.remove();
    this.listener = undefined;
  }
}
