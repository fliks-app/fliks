import {
  Component,
  ChangeDetectionStrategy,
  ElementRef,
  signal,
  viewChild,
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
  private readonly editorDialog = viewChild<ElementRef<HTMLDialogElement>>('editorDialog');

  readonly rows = signal<RoleRow[]>([]);
  readonly availablePermissions = signal<string[]>([]);
  readonly loading = signal(true);
  readonly listError = signal('');

  readonly isCreating = signal(false);
  readonly saving = signal(false);

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
    this.editorDialog()?.nativeElement.showModal();
  }

  openEdit(role: RoleRow) {
    this.isCreating.set(false);
    this.editingRole.set(role);
    this.formName.set(role.name);
    this.formPermissions.set(new Set(role.permissions));
    this.formIsDefault.set(role.isDefault);
    this.editorDialog()?.nativeElement.showModal();
  }

  closeEditor() {
    this.editorDialog()?.nativeElement.close();
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
    } catch {
      // handled by global error interceptor
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
