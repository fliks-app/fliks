import { Component, ChangeDetectionStrategy, inject, OnInit } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AuthService } from './core/services/auth.service';
import { ToastContainerComponent } from './shared/components/toast-container';
import { ConfirmationModalComponent } from './shared/components/confirmation-modal';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, ToastContainerComponent, ConfirmationModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
})
export class App implements OnInit {
  private readonly auth = inject(AuthService);

  ngOnInit() {
    this.auth.hydrateFromServer();
  }
}
