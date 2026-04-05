import { Component, ChangeDetectionStrategy, inject, OnInit, OnDestroy } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { AuthService } from './core/services/auth.service';
import { CastPlayerService } from './core/services/cast-player.service';
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
  private backButtonListener?: { remove: () => Promise<void> };

  ngOnInit() {
    this.auth.hydrateFromServer();

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
    }
  }

  ngOnDestroy() {
    this.backButtonListener?.remove();
  }
}
