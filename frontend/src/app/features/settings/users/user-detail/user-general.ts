import {
  Component,
  ChangeDetectionStrategy,
  signal,
  inject,
  OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  UsersApiService,
  UpdateUserBody,
} from '../../../../core/services/api/users-api.service';
import { UserDetailState } from './user-detail.state';
import { ToastService } from '../../../../core/services/toast.service';

@Component({
  selector: 'app-user-general',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './user-general.html',
})
export class UserGeneralComponent implements OnInit {
  private readonly api = inject(UsersApiService);
  private readonly translate = inject(TranslateService);
  readonly state = inject(UserDetailState);
  private readonly toast = inject(ToastService);

  readonly saving = signal(false);


  readonly formUsername = signal('');
  readonly formPassword = signal('');
  readonly formEmail = signal('');
  readonly formRoleId = signal<number | null>(null);
  readonly formIsAdmin = signal(false);
  readonly formEnabled = signal(true);

  ngOnInit() {
    const user = this.state.user();
    if (user) {
      this.formUsername.set(user.username);
      this.formRoleId.set(user.roleId);
      this.formIsAdmin.set(user.isAdmin ?? false);
      this.formEnabled.set(user.enabled);
    }
  }

  async save() {
    const user = this.state.user();
    if (!user) return;
    this.saving.set(true);
    const body: UpdateUserBody = {
      username: this.formUsername().trim() || undefined,
      roleId: this.formRoleId() ?? undefined,
      isAdmin: this.formIsAdmin(),
      enabled: this.formEnabled(),
    };
    if (this.formPassword()) body.password = this.formPassword();
    try {
      const updated = await this.api.update(user.id, body);
      this.state.user.set(updated);
      this.formPassword.set('');
      this.toast.success(this.translate.instant('settings.users.save_success'));
    } catch {
      // handled by global error interceptor
    } finally {
      this.saving.set(false);
    }
  }
}
