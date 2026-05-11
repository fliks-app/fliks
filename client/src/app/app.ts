import { Component, ChangeDetectionStrategy, inject, OnInit, OnDestroy } from '@angular/core';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { filter, take } from 'rxjs';
import { Capacitor } from '@capacitor/core';
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
  private backButtonListener?: { remove: () => Promise<void> };
  private resumeListener?: { remove: () => Promise<void> };

  ngOnInit() {
    this.auth.hydrateFromServer();
    // Pre-warm device profile cache (codec probing) so it's instant when the player needs it
    this.deviceProfile.getProfile();

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
        });
      });

      CapApp.addListener('backButton', () => {
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
        // Back at a top-level page with no in-app history left: stay put.
        // Minimising would drop the user out of the app on a "just navigate"
        // gesture, which on Android 14+ feels indistinguishable from a crash.
        // Modern UX convention is to leave the app via the home gesture or
        // the recent-apps switcher — never the back gesture. TV already
        // followed this rule; mobile now does too.
        return;
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
  }

  ngOnDestroy() {
    this.backButtonListener?.remove();
    this.resumeListener?.remove();
  }
}
