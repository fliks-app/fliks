import {
  Component,
  ChangeDetectionStrategy,
  signal,
  inject,
  OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  UsersApiService,
  UserRow,
  CreateUserBody,
  UpdateUserBody,
} from '../../../core/services/api/users-api.service';
import { RolesApiService, RoleRow } from '../../../core/services/api/roles-api.service';
import { AuthService } from '../../../core/services/auth.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { ToastService } from '../../../core/services/toast.service';

@Component({
  selector: 'app-users-settings',
  imports: [FormsModule, RouterLink, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './users.html',
})
export class UsersSettingsComponent implements OnInit {
  private readonly api = inject(UsersApiService);
  private readonly rolesApi = inject(RolesApiService);
  private readonly translate = inject(TranslateService);
  readonly auth = inject(AuthService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly toast = inject(ToastService);

  readonly rows = signal<UserRow[]>([]);
  readonly roles = signal<RoleRow[]>([]);
  readonly loading = signal(true);
  readonly listError = signal('');

  readonly editorOpen = signal(false);
  readonly isCreating = signal(false);
  readonly saving = signal(false);
  readonly saveError = signal('');
  readonly editingUser = signal<UserRow | null>(null);

  readonly formUsername = signal('');
  readonly formPassword = signal('');
  readonly formEmail = signal('');
  readonly formRoleId = signal<number | null>(null);
  readonly formEnabled = signal(true);

  ngOnInit() {
    this.reloadAll();
  }

  async reloadAll() {
    this.loading.set(true);
    try {
      const [list, roles] = await Promise.all([
        this.api.list(),
        this.rolesApi.list(),
      ]);
      this.rows.set(list);
      this.roles.set(roles);
    } catch {
      this.listError.set(this.translate.instant('settings.users.load_error'));
    } finally {
      this.loading.set(false);
    }
  }

  openCreate() {
    this.isCreating.set(true);
    this.editingUser.set(null);
    this.formUsername.set('');
    this.formPassword.set('');
    this.formEmail.set('');
    const defaultRole = this.roles().find((r) => r.isDefault);
    this.formRoleId.set(defaultRole?.id ?? this.roles()[0]?.id ?? null);
    this.formEnabled.set(true);
    this.saveError.set('');
    this.editorOpen.set(true);
  }

  openEdit(user: UserRow) {
    this.isCreating.set(false);
    this.editingUser.set(user);
    this.formUsername.set(user.username);
    this.formPassword.set('');
    this.formEmail.set('');
    this.formRoleId.set(user.roleId);
    this.formEnabled.set(user.enabled);
    this.saveError.set('');
    this.editorOpen.set(true);
  }

  closeEditor() {
    this.editorOpen.set(false);
  }

  async save() {
    this.saving.set(true);
    this.saveError.set('');
    try {
      if (this.isCreating()) {
        const body: CreateUserBody = {
          username: this.formUsername().trim(),
          password: this.formPassword(),
          roleId: this.formRoleId() ?? undefined,
          enabled: this.formEnabled(),
        };
        if (this.formEmail().trim()) body.email = this.formEmail().trim();
        await this.api.create(body);
      } else {
        const user = this.editingUser();
        if (!user) return;
        const body: UpdateUserBody = {
          username: this.formUsername().trim() || undefined,
          roleId: this.formRoleId() ?? undefined,
          enabled: this.formEnabled(),
        };
        if (this.formPassword()) body.password = this.formPassword();
        await this.api.update(user.id, body);
      }
      this.closeEditor();
      this.toast.success(this.translate.instant('settings.users.save_success'));
      await this.reloadAll();
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string | string[] } };
      const msg = Array.isArray(httpErr.error?.message)
        ? httpErr.error.message.join(', ')
        : httpErr.error?.message;
      this.saveError.set(msg ?? this.translate.instant('settings.users.save_error'));
    } finally {
      this.saving.set(false);
    }
  }

  async deleteUser(user: UserRow) {
    if (!await this.confirmation.confirm({ title: this.translate.instant('common.confirm'), message: this.translate.instant('settings.users.confirm_delete', { name: user.username }), variant: 'danger' })) return;
    try {
      await this.api.remove(user.id);
      await this.reloadAll();
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      void this.confirmation.alert({ title: this.translate.instant('common.error'), message: httpErr.error?.message ?? 'Error', variant: 'danger' });
    }
  }
}
