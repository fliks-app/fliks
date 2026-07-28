import { Component, ChangeDetectionStrategy, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { AuthService } from '../../core/services/auth.service';
import { ServerConfigService } from '../../core/services/server-config.service';
import { TvService } from '../../core/services/tv.service';
import { DropdownMenuComponent } from './dropdown-menu';
import { UserAvatarComponent } from './user-avatar/user-avatar';
import {
  LucideUser,
  LucideSettings,
  LucideShield,
  LucideRepeat,
  LucideLogOut,
  LucideServer,
  LucideMonitorSmartphone,
} from '@lucide/angular';

@Component({
  selector: 'app-user-menu',
  imports: [
    RouterLink, TranslateModule,
    DropdownMenuComponent, UserAvatarComponent,
    LucideUser, LucideSettings, LucideShield, LucideRepeat, LucideLogOut,
    LucideServer, LucideMonitorSmartphone,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './user-menu.html',
})
export class UserMenuComponent {
  readonly auth = inject(AuthService);
  readonly tv = inject(TvService);
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
