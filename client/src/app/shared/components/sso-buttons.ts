import { Component, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { AuthService } from '../../core/services/auth.service';

/** One "Sign in with <name>" button per provider this shell can complete; nothing otherwise. The page loads `oidcInfo()`. */
@Component({
  selector: 'app-sso-buttons',
  imports: [TranslatePipe],
  templateUrl: './sso-buttons.html',
})
export class SsoButtonsComponent {
  private readonly auth = inject(AuthService);
  readonly providers = this.auth.ssoProviders;
  readonly busy = this.auth.oidcBusy;

  /** A failed start (throttled, provider gone) is already toasted by the interceptor. */
  async signIn(id: number): Promise<void> {
    await this.auth.oidcSignIn(id).catch(() => undefined);
  }
}
