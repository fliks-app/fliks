import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { Capacitor } from '@capacitor/core';
import { AuthService, PublicUserSummary } from '../../core/services/auth.service';
import { ServerConfigService } from '../../core/services/server-config.service';
import { initialsAvatar } from '../../core/utils/initials-avatar';
import { LucideMonitorSmartphone, LucideKeyRound, LucideUserRoundPen } from '@lucide/angular';

@Component({
  selector: 'app-select-user',
  imports: [
    TranslateModule,
    LucideMonitorSmartphone,
    LucideKeyRound,
    LucideUserRoundPen,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './select-user.html',
})
export class SelectUserComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly serverConfig = inject(ServerConfigService);

  readonly users = signal<PublicUserSummary[]>([]);
  readonly loading = signal(true);
  readonly error = signal('');
  /** id of the user whose action sheet is open, or null. */
  readonly openSheetFor = signal<number | null>(null);
  readonly isNative = Capacitor.isNativePlatform();

  constructor() {
    void this.loadUsers();
  }

  async loadUsers() {
    this.loading.set(true);
    this.error.set('');
    try {
      const list = await this.auth.listUsersPublic();
      this.users.set(list);
    } catch {
      this.error.set('select_user.load_error');
    } finally {
      this.loading.set(false);
    }
  }

  selectUser(user: PublicUserSummary) {
    this.openSheetFor.set(user.id);
  }

  closeSheet() {
    this.openSheetFor.set(null);
  }

  goToPasswordLogin(user: PublicUserSummary) {
    void this.router.navigate(['/login'], { queryParams: { username: user.username } });
  }

  goToQuickConnect(user: PublicUserSummary) {
    void this.router.navigate(['/quick-connect', user.id]);
  }

  goToOtherUser() {
    void this.router.navigate(['/login']);
  }

  async changeServer() {
    await this.serverConfig.clear();
    void this.router.navigate(['/setup']);
  }

  /**
   * Stable color + initials from a username for users without an avatar.
   * Pure function — exposed on the component so the template can read it.
   */
  initials(name: string) {
    return initialsAvatar(name);
  }
}
