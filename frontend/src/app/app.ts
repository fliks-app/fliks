import { Component, ChangeDetectionStrategy, inject, OnInit, OnDestroy } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { AuthService } from './core/services/auth.service';
import { CastPlayerService } from './core/services/cast-player.service';
import { SseService } from './core/services/sse.service';
import { DownloadManagerService } from './core/services/download-manager.service';
import { BrowserDeviceProfileService } from './core/services/browser-device-profile.service';
import { ToastContainerComponent } from './shared/components/toast-container';
import { ConfirmationModalComponent } from './shared/components/confirmation-modal';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, ToastContainerComponent, ConfirmationModalComponent],
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
  private backButtonListener?: { remove: () => Promise<void> };
  private resumeListener?: { remove: () => Promise<void> };

  ngOnInit() {
    this.auth.hydrateFromServer();
    // Pre-warm device profile cache (codec probing) so it's instant when the player needs it
    this.deviceProfile.getProfile();

    if (Capacitor.isNativePlatform()) {
      document.body.classList.add('native');
      CapApp.addListener('backButton', ({ canGoBack }) => {
        // Close Cast overlay first if open
        if (this.castPlayer.expanded()) {
          this.castPlayer.expanded.set(false);
          return;
        }
        if (canGoBack) {
          window.history.back();
        } else {
          CapApp.minimizeApp();
        }
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
