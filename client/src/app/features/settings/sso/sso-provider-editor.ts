import { Component, ElementRef, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucideArrowDown, LucideArrowUp, LucideCopy, LucideX } from '@lucide/angular';
import {
  OidcApiService,
  OidcPrompt,
  OidcProviderBody,
  OidcProviderRow,
  OidcRoleMapping,
  OidcTestResult,
} from '../../../core/services/api/oidc-api.service';
import type { RoleRow } from '../../../core/services/api/roles-api.service';
import { ToastService } from '../../../core/services/toast.service';
import { ModalFooterComponent } from '../../../shared/components/modal-footer';
import { ModalHeaderComponent } from '../../../shared/components/modal-header';
import { TvSelectDirective } from '../../../shared/directives/tv-select.directive';

const lines = (v: string): string[] => v.split('\n').map((s) => s.trim()).filter(Boolean);

@Component({
  selector: 'app-sso-provider-editor',
  imports: [
    FormsModule,
    TranslatePipe,
    TvSelectDirective,
    ModalHeaderComponent,
    ModalFooterComponent,
    LucideArrowUp,
    LucideArrowDown,
    LucideCopy,
    LucideX,
  ],
  templateUrl: './sso-provider-editor.html',
})
export class SsoProviderEditorComponent {
  private readonly api = inject(OidcApiService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  readonly roles = input.required<RoleRow[]>();
  readonly publicUrl = input('');
  /** Emits after a save, so the list reloads. */
  readonly saved = output<void>();

  readonly editing = signal<OidcProviderRow | null>(null);
  readonly saving = signal(false);
  readonly testing = signal(false);
  readonly testResult = signal<OidcTestResult | null>(null);

  readonly name = signal('');
  readonly issuer = signal('');
  readonly clientId = signal('');
  readonly clientSecret = signal('');
  readonly caPem = signal('');
  readonly scope = signal('openid profile email');
  readonly prompt = signal<OidcPrompt | ''>('');
  readonly usernameClaim = signal('preferred_username');
  readonly groupsClaim = signal('');
  readonly allowedGroups = signal('');
  readonly adminGroups = signal('');
  readonly roleMappings = signal<OidcRoleMapping[]>([]);
  readonly autoRegister = signal(false);
  readonly matchByEmail = signal(false);
  readonly endSessionAtProvider = signal(false);
  readonly accountUrl = signal('');
  readonly enabled = signal(true);

  readonly prompts: (OidcPrompt | '')[] = ['', 'login', 'consent', 'select_account'];

  /** The three URIs to register at the provider; null until the provider has an id and `public_url` is set. */
  readonly uris = computed(() => {
    const base = this.publicUrl().replace(/\/+$/, '');
    const id = this.editing()?.id;
    if (!base || id === undefined) return null;
    return [
      { label: 'settings.sso.uri_redirect', value: `${base}/api/auth/oidc/${id}/callback` },
      { label: 'settings.sso.uri_backchannel', value: `${base}/api/auth/oidc/${id}/backchannel-logout` },
      { label: 'settings.sso.uri_logout', value: `${base}/login?autoLaunch=0` },
    ];
  });

  open(row: OidcProviderRow | null): void {
    this.editing.set(row);
    this.testResult.set(null);
    this.name.set(row?.name ?? '');
    this.issuer.set(row?.issuer ?? '');
    this.clientId.set(row?.clientId ?? '');
    this.clientSecret.set('');
    this.caPem.set(row?.caPem ?? '');
    this.scope.set(row?.scope ?? 'openid profile email');
    this.prompt.set(row?.prompt ?? '');
    this.usernameClaim.set(row?.usernameClaim ?? 'preferred_username');
    this.groupsClaim.set(row?.groupsClaim ?? '');
    this.allowedGroups.set((row?.allowedGroups ?? []).join('\n'));
    this.adminGroups.set((row?.adminGroups ?? []).join('\n'));
    this.roleMappings.set((row?.roleMappings ?? []).map((m) => ({ ...m })));
    this.autoRegister.set(row?.autoRegister ?? false);
    this.matchByEmail.set(row?.matchByEmail ?? false);
    this.endSessionAtProvider.set(row?.endSessionAtProvider ?? false);
    this.accountUrl.set(row?.accountUrl ?? '');
    this.enabled.set(row?.enabled ?? true);
    this.dialog().nativeElement.showModal();
  }

  close(): void {
    this.dialog().nativeElement.close();
  }

  addMapping(): void {
    const role = this.roles().find((r) => r.isDefault) ?? this.roles()[0];
    if (role) this.roleMappings.update((l) => [...l, { group: '', roleId: role.id }]);
  }

  setMapping(i: number, patch: Partial<OidcRoleMapping>): void {
    this.roleMappings.update((l) => l.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  }

  moveMapping(i: number, to: number): void {
    this.roleMappings.update((l) => {
      const next = [...l];
      next.splice(to, 0, ...next.splice(i, 1));
      return next;
    });
  }

  removeMapping(i: number): void {
    this.roleMappings.update((l) => l.filter((_, j) => j !== i));
  }

  async test(): Promise<void> {
    this.testing.set(true);
    try {
      this.testResult.set(await this.api.test(this.issuer().trim(), this.caPem().trim() || null));
    } catch {
      this.testResult.set({ ok: false, error: this.translate.instant('settings.sso.test_failed') });
    } finally {
      this.testing.set(false);
    }
  }

  async copy(value: string): Promise<void> {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(value);
      this.toast.success(this.translate.instant('settings.sso.copied'));
    } catch {
      // Clipboard denied: the value stays readable in its field.
    }
  }

  readonly canSave = computed(
    () => !!this.name().trim() && !!this.issuer().trim() && !!this.clientId().trim(),
  );

  async save(): Promise<void> {
    if (!this.canSave()) return;
    const row = this.editing();
    const body: OidcProviderBody = {
      name: this.name().trim(),
      issuer: this.issuer().trim(),
      clientId: this.clientId().trim(),
      clientSecret: this.clientSecret(),
      caPem: this.caPem().trim() || null,
      scope: this.scope().trim(),
      prompt: this.prompt() || null,
      usernameClaim: this.usernameClaim().trim(),
      groupsClaim: this.groupsClaim().trim() || null,
      allowedGroups: lines(this.allowedGroups()),
      adminGroups: lines(this.adminGroups()),
      roleMappings: this.roleMappings().filter((m) => m.group.trim()).map((m) => ({ ...m, group: m.group.trim() })),
      autoRegister: this.autoRegister(),
      matchByEmail: this.matchByEmail(),
      endSessionAtProvider: this.endSessionAtProvider(),
      accountUrl: this.accountUrl().trim() || null,
      enabled: this.enabled(),
    };
    this.saving.set(true);
    try {
      await (row ? this.api.update(row.id, body) : this.api.create(body));
      this.toast.success(this.translate.instant('settings.sso.saved'));
      this.close();
      this.saved.emit();
    } catch {
      // handled by global error interceptor
    } finally {
      this.saving.set(false);
    }
  }
}
