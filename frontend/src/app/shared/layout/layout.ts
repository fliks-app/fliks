import { Component, ChangeDetectionStrategy, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet, Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-layout',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './layout.html',
})
export class LayoutComponent {
  readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  /** Keep the settings <details> open when any /settings/* route is active */
  isSettingsOpen(): boolean {
    return this.router.url.startsWith('/settings');
  }
}
