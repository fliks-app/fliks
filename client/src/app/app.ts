import { Component, ChangeDetectionStrategy, inject, OnInit, OnDestroy } from '@angular/core';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { filter, take } from 'rxjs';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { SplashScreen } from '@capacitor/splash-screen';
import { AuthService } from './core/services/auth.service';
import { CastPlayerService } from './core/services/cast-player.service';
import { SseService } from './core/services/sse.service';
import { DownloadManagerService } from './core/services/download-manager.service';
import { BrowserDeviceProfileService } from './core/services/browser-device-profile.service';
import { TvService } from './core/services/tv.service';
import { TvSpatialNavService } from './core/services/tv-spatial-nav.service';
import { ToastContainerComponent } from './shared/components/toast-container';
import { ConfirmationModalComponent } from './shared/components/confirmation-modal';
import { SelectPickerComponent } from './shared/components/select-picker';
import { DismissableStackService } from './core/services/dismissable-stack.service';
import { NavbarService } from './core/services/navbar.service';
import { PwaAutoUpdateService } from './core/services/pwa-auto-update.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, ToastContainerComponent, ConfirmationModalComponent, SelectPickerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
})
export class App implements OnInit, OnDestroy {
  private readonly auth = inject(AuthService);
  private readonly castPlayer = inject(CastPlayerService);
  private readonly sse = inject(SseService);
  /** Injected to ensure DownloadManagerService singleton is created (authEffect, nativeEffect). */
  private readonly dlManager = inject(DownloadManagerService);
  private readonly deviceProfile = inject(BrowserDeviceProfileService);
  /** Eagerly instantiate TvService so it can detect Android TV and set the body `tv` class. */
  private readonly tv = inject(TvService);
  /** Eagerly instantiate to bind the global D-pad handler on TV. */
  private readonly tvSpatialNav = inject(TvSpatialNavService);
  private readonly router = inject(Router);
  private readonly dismissStack = inject(DismissableStackService);
  private readonly navbar = inject(NavbarService);
  private readonly pwaAutoUpdate = inject(PwaAutoUpdateService);
  private backButtonListener?: { remove: () => Promise<void> };
  private resumeListener?: { remove: () => Promise<void> };
  private tvBackKeyListener?: (e: KeyboardEvent) => void;
  private escapeKeyListener?: (e: KeyboardEvent) => void;

  ngOnInit() {
    this.auth.hydrateFromServer();
    // Pre-warm device profile cache (codec probing) so it's instant when the player needs it
    this.deviceProfile.getProfile();
    // Watch for a fresher PWA build emitted by the Angular service worker
    // — when one lands, full-reload the tab so the new asset map is live.
    this.pwaAutoUpdate.init();

    this.initInputModalityTracking();

    if (Capacitor.isNativePlatform()) {
      document.body.classList.add('native');

      // Hide the native splash on the first NavigationEnd. The splash sits in
      // launchAutoHide:false mode so the WebView's loading state is fully
      // covered — we dismiss it once Angular has rendered actual content.
      this.router.events.pipe(
        filter((e): e is NavigationEnd => e instanceof NavigationEnd),
        take(1),
      ).subscribe(() => {
        // Defer one frame so the rendered template has actually painted before
        // the splash fades out — otherwise the user briefly sees a blank app.
        requestAnimationFrame(() => {
          void SplashScreen.hide({ fadeOutDuration: 200 });
          // On a cold start the status bar is left opaque (a black strip under
          // it) until a relayout, because the splash teardown drops the window
          // insets that drive env(safe-area-inset-*). Re-assert edge-to-edge a
          // short beat after hide() — once the window has settled the insets
          // re-publish and the status bar goes transparent. (Chaining directly
          // on hide() resolves too early and the re-assert doesn't take.)
          if (Capacitor.getPlatform() === 'android') {
            const Immersive = registerPlugin<{ applyEdgeToEdge(): Promise<void> }>('Immersive');
            setTimeout(() => void Immersive.applyEdgeToEdge().catch(() => {}), 100);
          }
        });
      });

      CapApp.addListener('backButton', () => {
        this.handleBackButton();
      }).then((handle) => {
        this.backButtonListener = handle;
      });

      // Reconnect SSE when app comes back from background
      CapApp.addListener('resume', () => {
        this.sse.reconnect();
      }).then((handle) => {
        this.resumeListener = handle;
      });
    }

    // Browser/desktop Escape mirrors the hardware back button: closes the
    // topmost dismissable layer (open dropdown, bottom sheet, modal) if
    // any, else falls through to route-level back. Skip when focus is on
    // a form control whose native Escape behaviour is preferable:
    //  - INPUT / TEXTAREA / contentEditable: cancel inline edits without
    //    navigating away.
    //  - SELECT: close the native option list while keeping focus on the
    //    select (our preventDefault would otherwise blur it, dropping
    //    focus to <body>).
    this.escapeKeyListener = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Defer to the browser's default Escape when focus is on a form
      // control. `closest()` catches the open-select case where Chrome
      // dispatches keydown on the focused <option> rather than the
      // <select> itself — both resolve to the same <select> ancestor.
      // `activeElement` is a second signal in case the browser routes
      // the event to <document> while the dropdown is open.
      const target = e.target as HTMLElement | null;
      const active = document.activeElement as HTMLElement | null;
      const isFormControl = (el: HTMLElement | null) =>
        !!el && (el.isContentEditable || !!el.closest('select, input, textarea'));
      if (isFormControl(target) || isFormControl(active)) return;
      e.preventDefault();
      e.stopPropagation();
      this.handleBackButton();
    };
    window.addEventListener('keydown', this.escapeKeyListener, true);

    // Smart TV "Return" remote key. Capacitor's `backButton` event never
    // fires here (Tizen/webOS don't run through Capacitor), so without an
    // explicit handler the player gets stuck with no way out. The button
    // surfaces as keyCode 10009 on Tizen and 461 (`key: 'GoBack'`) on
    // webOS — physical buttons, no Android-style back gesture. Same logic
    // as the Capacitor handler, factored out into `handleBackButton`.
    const platform = this.tv.tvPlatform();
    if (platform === 'tizen' || platform === 'webos') {
      const handler = (e: KeyboardEvent) => {
        if (
          e.keyCode === 10009 ||
          e.keyCode === 461 ||
          e.key === 'XF86Back' ||
          e.key === 'GoBack'
        ) {
          e.preventDefault();
          this.handleBackButton();
        }
      };
      this.tvBackKeyListener = handler;
      window.addEventListener('keydown', handler);
    }
  }

  /** Track input modality (keyboard / D-pad vs pointer / touch) and
   *  toggle `body.keyboard-modality`. CSS gates `:focus-visible`
   *  visuals on it so an iOS long-press — which Safari WebKit
   *  incorrectly classifies as a focus-visible trigger — doesn't
   *  paint the high-contrast focus ring on the card the user was
   *  trying to context-tap. The class flips on the first
   *  navigation-key press and clears on the next pointer / touch
   *  interaction. TV stays focused-visible regardless (`body.tv`
   *  short-circuits the suppression rule in styles.css). */
  private initInputModalityTracking(): void {
    const NAV_KEYS = new Set([
      'Tab',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Enter',
      ' ',
    ]);
    let keyboardActive = false;
    const setKeyboard = (on: boolean) => {
      if (on === keyboardActive) return;
      keyboardActive = on;
      document.body.classList.toggle('keyboard-modality', on);
    };
    window.addEventListener('keydown', (e) => {
      if (NAV_KEYS.has(e.key)) setKeyboard(true);
    });
    const clearOnPointer = () => setKeyboard(false);
    window.addEventListener('pointerdown', clearOnPointer, { capture: true });
    window.addEventListener('touchstart', clearOnPointer, {
      capture: true,
      passive: true,
    });
  }

  /** Hardware-back common path — Capacitor (Android/iOS) and Tizen share
   *  the same close/dismiss/exit sequence so the UX matches across
   *  platforms. The only thing that differs is the event source. */
  private handleBackButton(): void {
    // A focused <select> means its picker is open (or about to open
    // when the user pressed Enter). Blur to close it before any
    // route-level back logic fires.
    const active = document.activeElement as HTMLElement | null;
    if (active?.tagName === 'SELECT') {
      active.blur();
      return;
    }
    // Close Cast overlay first if open
    if (this.castPlayer.expanded()) {
      this.castPlayer.expanded.set(false);
      return;
    }
    // Close any open bottom sheet / dismissable layer before navigating.
    if (this.dismissStack.dismissTop()) {
      return;
    }
    // On /watch, defer to the player's own back handler so the hardware
    // back / gesture matches the in-UI back arrow (replaceUrl to the
    // media detail page rather than history.back which can land on the
    // tile the user came from — different from the arrow's behaviour).
    if (this.router.url.startsWith('/watch')) {
      window.dispatchEvent(new CustomEvent('app:playerBack'));
      return;
    }
    // Capacitor's `canGoBack` reflects WebView full-page history, which
    // SPAs (Angular Router uses pushState) never grow. NavbarService
    // tracks NavigationEnd events and navigates explicitly to the
    // previous in-app URL — `window.history.back()` doesn't reliably
    // pop pushState entries on Capacitor's Android WebView.
    if (this.navbar.canGoBack()) {
      this.navbar.goBack();
      return;
    }
    // Top-level with no in-app history: leave the app. We preventDefault'd
    // the Return key above (to suppress the WebApp default exit prompt), so
    // re-fire the platform's own exit explicitly — Tizen's application.exit,
    // webOS's platformBack (returns to the launcher / previous app).
    const platform = this.tv.tvPlatform();
    if (platform === 'tizen') {
      const tizen = (window as unknown as { tizen?: { application?: { getCurrentApplication: () => { exit: () => void } } } }).tizen;
      try {
        tizen?.application?.getCurrentApplication().exit();
      } catch {
        /* exit() can throw on dev profiles — ignore */
      }
    } else if (platform === 'webos') {
      const sys = (window as unknown as { webOSSystem?: { platformBack?: () => void } }).webOSSystem;
      try {
        sys?.platformBack?.();
      } catch {
        /* platformBack unavailable on some firmware — ignore */
      }
    }
  }

  ngOnDestroy() {
    this.backButtonListener?.remove();
    this.resumeListener?.remove();
    if (this.tvBackKeyListener) {
      window.removeEventListener('keydown', this.tvBackKeyListener);
    }
    if (this.escapeKeyListener) {
      window.removeEventListener('keydown', this.escapeKeyListener, true);
    }
  }
}
