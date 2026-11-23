import { Component, inject, input } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { CountsApiService } from '../../core/services/api/counts-api.service';
import { AuthService } from '../../core/services/auth.service';
import { ServerConfigService } from '../../core/services/server-config.service';
import { TvService } from '../../core/services/tv.service';
import { DropdownMenuComponent } from './dropdown-menu';
import { UserAvatarComponent } from './user-avatar/user-avatar';
import { LucideDynamicIcon } from '@lucide/angular';
import { icons } from '../icons';

@Component({
  selector: 'app-user-menu',
  imports: [
    RouterLink, TranslatePipe,
    DropdownMenuComponent, UserAvatarComponent, LucideDynamicIcon],
  templateUrl: './user-menu.html',
})
export class UserMenuComponent {
  protected readonly icons = icons;

  /** Where the dropdown opens; the rail footer opens it beside itself. */
  readonly placement = input<'bottom-end' | 'right-end'>('bottom-end');
  readonly auth = inject(AuthService);
  readonly tv = inject(TvService);
  protected readonly systemAttention = inject(CountsApiService).systemAttention;
  private readonly router = inject(Router);
  private readonly serverConfig = inject(ServerConfigService);
  /** Only a standalone bundle can point elsewhere: web is served by the very
   *  backend it talks to. */
  protected readonly canChangeServer = this.serverConfig.isNative;

  /** Leaves the account signed in on this device: the picker offers it back in
   *  one tap. `replaceUrl` so hardware back can't land on the shell we left. */
  protected async switchUser() {
    await this.auth.beginUserSwitch();
    void this.router.navigate(['/select-user'], { replaceUrl: true });
  }

  /** Sessions — this one included — are kept: /setup resumes whichever server
   *  the user picks. */
  protected changeServer() {
    void this.router.navigate(['/setup']);
  }

  protected logout() {
    void this.auth.logout();
  }
}
