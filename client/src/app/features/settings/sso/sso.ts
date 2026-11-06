import { Component, OnInit, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CdkDrag, CdkDragHandle, CdkDragPlaceholder, CdkDropList, moveItemInArray } from '@angular/cdk/drag-drop';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucideGripVertical, LucidePencil, LucideTrash2 } from '@lucide/angular';
import { OidcApiService, OidcProviderBody, OidcProviderRow } from '../../../core/services/api/oidc-api.service';
import { RolesApiService, RoleRow } from '../../../core/services/api/roles-api.service';
import { SettingsApiService } from '../../../core/services/api/settings-api.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { TvService } from '../../../core/services/tv.service';
import { ToastService } from '../../../core/services/toast.service';
import { DropListSettleDirective } from '../../../shared/directives/drop-list-settle.directive';
import { TvSelectDirective } from '../../../shared/directives/tv-select.directive';
import { EnabledSwitchComponent } from '../../../shared/components/enabled-switch';
import { SsoProviderEditorComponent } from './sso-provider-editor';

/** The PUT body that leaves a provider as it is; a blank secret keeps the stored one. */
function bodyOf(row: OidcProviderRow, patch: Partial<OidcProviderBody> = {}): OidcProviderBody {
  const { id: _id, clientSecretSet: _set, linkedUsers: _n, ...rest } = row;
  return { ...rest, clientSecret: '', ...patch };
}

@Component({
  selector: 'app-sso-settings',
  imports: [
    FormsModule,
    TranslatePipe,
    TvSelectDirective,
    EnabledSwitchComponent,
    SsoProviderEditorComponent,
    CdkDropList,
    CdkDrag,
    CdkDragHandle,
    CdkDragPlaceholder,
    DropListSettleDirective,
    LucideGripVertical,
    LucidePencil,
    LucideTrash2,
  ],
  templateUrl: './sso.html',
})
export class SsoSettingsComponent implements OnInit {
  private readonly api = inject(OidcApiService);
  private readonly rolesApi = inject(RolesApiService);
  private readonly settings = inject(SettingsApiService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly editor = viewChild.required(SsoProviderEditorComponent);
  readonly tv = inject(TvService);

  readonly loading = signal(true);
  readonly error = signal('');
  readonly providers = signal<OidcProviderRow[]>([]);
  readonly roles = signal<RoleRow[]>([]);
  readonly publicUrl = signal('');
  readonly passwordLogin = signal('everyone');
  readonly autoLaunch = signal('');
  readonly togglingId = signal<number | null>(null);
  readonly savingPolicy = signal(false);

  ngOnInit(): void {
    void this.reload();
  }

  async reload(): Promise<void> {
    try {
      const [providers, roles, all] = await Promise.all([this.api.list(), this.rolesApi.list(), this.settings.getAll()]);
      this.providers.set([...providers].sort((a, b) => a.position - b.position));
      this.roles.set(roles);
      this.publicUrl.set(all['public_url'] ?? '');
      this.passwordLogin.set(all['password_login'] === 'admins' ? 'admins' : 'everyone');
      this.autoLaunch.set(all['oidc_auto_launch'] ?? '');
    } catch {
      this.error.set(this.translate.instant('settings.sso.load_error'));
    } finally {
      this.loading.set(false);
    }
  }

  openEditor(row: OidcProviderRow | null): void {
    this.editor().open(row);
  }

  async toggle(row: OidcProviderRow): Promise<void> {
    this.togglingId.set(row.id);
    try {
      await this.api.update(row.id, bodyOf(row, { enabled: !row.enabled }));
      await this.reload();
    } catch {
      // handled by global error interceptor
    } finally {
      this.togglingId.set(null);
    }
  }

  async remove(row: OidcProviderRow): Promise<void> {
    const ok = await this.confirmation.confirm({
      title: this.translate.instant('common.confirm'),
      message: this.translate.instant('settings.sso.confirm_delete', { name: row.name }),
      variant: 'danger',
    });
    if (!ok) return;
    try {
      await this.api.remove(row.id);
      await this.reload();
    } catch {
      // handled by global error interceptor
    }
  }

  async reorder(from: number, to: number): Promise<void> {
    const list = [...this.providers()];
    if (from === to || to < 0 || to >= list.length) return;
    moveItemInArray(list, from, to);
    const previous = this.providers();
    this.providers.set(list.map((p, i) => ({ ...p, position: i })));
    try {
      await Promise.all(
        list.flatMap((p, i) => (p.position === i ? [] : [this.api.update(p.id, bodyOf(p, { position: i }))])),
      );
    } catch {
      this.providers.set(previous);
    }
  }

  /** Both keys together: "admins only" is refused by the server while no provider is enabled. */
  async savePolicy(): Promise<void> {
    this.savingPolicy.set(true);
    try {
      await this.settings.setBulk({ password_login: this.passwordLogin(), oidc_auto_launch: this.autoLaunch() });
      this.toast.success(this.translate.instant('settings.sso.saved'));
    } catch {
      await this.reload();
    } finally {
      this.savingPolicy.set(false);
    }
  }
}
