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
  UserRow,
  UpdateUserBody,
} from '../../../core/services/api/users-api.service';
import { AuthService } from '../../../core/services/auth.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';

@Component({
  selector: 'app-users-settings',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './users.html',
})
export class UsersSettingsComponent implements OnInit {
  private readonly api = inject(UsersApiService);
  private readonly translate = inject(TranslateService);
  readonly auth = inject(AuthService);
  private readonly confirmation = inject(ConfirmationService);

  readonly rows = signal<UserRow[]>([]);
  readonly loading = signal(true);
  readonly listError = signal('');

  readonly editorOpen = signal(false);
  readonly saving = signal(false);
  readonly saveError = signal('');
  readonly editingUser = signal<UserRow | null>(null);

  readonly formUsername = signal('');
  readonly formPassword = signal('');
  readonly formRole = signal<'admin' | 'user' | 'readonly'>('user');
  readonly formEnabled = signal(true);

  readonly regeneratedKey = signal('');

  ngOnInit() {
    this.reloadAll();
  }

  async reloadAll() {
    this.loading.set(true);
    try {
      const list = await this.api.list();
      this.rows.set(list);
    } catch {
      this.listError.set(this.translate.instant('settings.users.load_error'));
    } finally {
      this.loading.set(false);
    }
  }

  openEdit(user: UserRow) {
    this.editingUser.set(user);
    this.formUsername.set(user.username);
    this.formPassword.set('');
    this.formRole.set(user.role);
    this.formEnabled.set(user.enabled);
    this.saveError.set('');
    this.regeneratedKey.set('');
    this.editorOpen.set(true);
  }

  closeEditor() {
    this.editorOpen.set(false);
  }

  async save() {
    const user = this.editingUser();
    if (!user) return;
    this.saving.set(true);
    this.saveError.set('');
    const body: UpdateUserBody = {
      username: this.formUsername().trim() || undefined,
      role: this.formRole(),
      enabled: this.formEnabled(),
    };
    if (this.formPassword()) body.password = this.formPassword();
    try {
      await this.api.update(user.id, body);
      this.closeEditor();
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

  async regenerateApiKey(user: UserRow) {
    if (!await this.confirmation.confirm({ title: this.translate.instant('common.confirm'), message: this.translate.instant('settings.users.confirm_regen_key'), variant: 'danger' })) return;
    try {
      const res = await this.api.regenerateApiKey(user.id);
      this.regeneratedKey.set(res.apiKey);
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      void this.confirmation.alert({ title: this.translate.instant('common.error'), message: httpErr.error?.message ?? 'Error', variant: 'danger' });
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
