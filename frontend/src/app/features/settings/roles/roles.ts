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
  RolesApiService,
  RoleRow,
} from '../../../core/services/api/roles-api.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { ToastService } from '../../../core/services/toast.service';

@Component({
  selector: 'app-roles-settings',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './roles.html',
})
export class RolesSettingsComponent implements OnInit {
  private readonly api = inject(RolesApiService);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly toast = inject(ToastService);

  readonly rows = signal<RoleRow[]>([]);
  readonly availablePermissions = signal<string[]>([]);
  readonly loading = signal(true);
  readonly listError = signal('');

  readonly editorOpen = signal(false);
  readonly isCreating = signal(false);
  readonly saving = signal(false);
  readonly saveError = signal('');
  readonly editingRole = signal<RoleRow | null>(null);

  readonly formName = signal('');
  readonly formPermissions = signal<Set<string>>(new Set());
  readonly formIsDefault = signal(false);

  ngOnInit() {
    this.reloadAll();
  }

  async reloadAll() {
    this.loading.set(true);
    try {
      const [list, perms] = await Promise.all([
        this.api.list(),
        this.api.getPermissions(),
      ]);
      this.rows.set(list);
      this.availablePermissions.set(perms);
    } catch {
      this.listError.set(this.translate.instant('settings.roles.load_error'));
    } finally {
      this.loading.set(false);
    }
  }

  openCreate() {
    this.isCreating.set(true);
    this.editingRole.set(null);
    this.formName.set('');
    this.formPermissions.set(new Set());
    this.formIsDefault.set(false);
    this.saveError.set('');
    this.editorOpen.set(true);
  }

  openEdit(role: RoleRow) {
    this.isCreating.set(false);
    this.editingRole.set(role);
    this.formName.set(role.name);
    this.formPermissions.set(new Set(role.permissions));
    this.formIsDefault.set(role.isDefault);
    this.saveError.set('');
    this.editorOpen.set(true);
  }

  closeEditor() {
    this.editorOpen.set(false);
  }

  togglePermission(perm: string) {
    this.formPermissions.update((set) => {
      const next = new Set(set);
      if (next.has(perm)) next.delete(perm);
      else next.add(perm);
      return next;
    });
  }

  async save() {
    this.saving.set(true);
    this.saveError.set('');
    const permissions = [...this.formPermissions()];
    try {
      if (this.isCreating()) {
        await this.api.create({
          name: this.formName().trim(),
          permissions,
          isDefault: this.formIsDefault(),
        });
      } else {
        const role = this.editingRole();
        if (!role) return;
        await this.api.update(role.id, {
          name: this.formName().trim(),
          permissions,
          isDefault: this.formIsDefault(),
        });
      }
      this.closeEditor();
      this.toast.success(this.translate.instant('settings.roles.save_success'));
      await this.reloadAll();
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string | string[] } };
      const msg = Array.isArray(httpErr.error?.message)
        ? httpErr.error.message.join(', ')
        : httpErr.error?.message;
      this.saveError.set(msg ?? this.translate.instant('settings.roles.save_error'));
    } finally {
      this.saving.set(false);
    }
  }

  async deleteRole(role: RoleRow) {
    if (
      !(await this.confirmation.confirm({
        title: this.translate.instant('common.confirm'),
        message: this.translate.instant('settings.roles.confirm_delete', {
          name: role.name,
        }),
        variant: 'danger',
      }))
    )
      return;
    try {
      await this.api.remove(role.id);
      await this.reloadAll();
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      void this.confirmation.alert({
        title: this.translate.instant('common.error'),
        message: httpErr.error?.message ?? 'Error',
        variant: 'danger',
      });
    }
  }

  /** Human-readable permission label. */
  permLabel(perm: string): string {
    const key = 'permissions.' + perm;
    const translated = this.translate.instant(key);
    return translated !== key ? translated : perm;
  }
}
