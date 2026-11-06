import {
  Component,
  computed,
  signal,
  inject,
  OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TvSelectDirective } from '../../../../shared/directives/tv-select.directive';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
  UsersApiService,
  UpdateUserBody,
  UserRow,
  passwordErrorMessage,
} from '../../../../core/services/api/users-api.service';
import {
  LibrariesApiService,
  Library,
} from '../../../../core/services/api/libraries-api.service';
import { UserDetailState } from './user-detail.state';
import { AuthService } from '../../../../core/services/auth.service';
import { ToastService } from '../../../../core/services/toast.service';
import { ConfirmationService } from '../../../../core/services/confirmation.service';
import { LucideIconComponent } from '../../../../shared/components/lucide-icon';

type QuotaKey = 'movieQuotaLimit' | 'seriesQuotaLimit' | 'bookQuotaLimit' | 'quotaPeriodDays';
const QUOTA_KEYS: QuotaKey[] = ['movieQuotaLimit', 'seriesQuotaLimit', 'bookQuotaLimit', 'quotaPeriodDays'];

@Component({
  selector: 'app-user-general',
  imports: [TvSelectDirective, FormsModule, TranslatePipe, LucideIconComponent],
  templateUrl: './user-general.html',
})
export class UserGeneralComponent implements OnInit {
  private readonly api = inject(UsersApiService);
  private readonly librariesApi = inject(LibrariesApiService);
  private readonly translate = inject(TranslateService);
  readonly state = inject(UserDetailState);
  private readonly toast = inject(ToastService);
  /** Changing a role grants its permissions, so the server keeps it behind `roles.manage`. */
  private readonly auth = inject(AuthService);
  private readonly confirmation = inject(ConfirmationService);
  readonly canAssignRole = this.auth.hasPermission('roles.manage');
  /** Changing one's own password proves the current one; an admin resetting another user's does not. */
  readonly isSelf = computed(() => this.state.user()?.id === this.auth.user()?.id);
  /** Not on one's own page, and only an admin signs out an admin. */
  readonly canSignOutEverywhere = computed(
    () => !this.isSelf() && (!this.state.user()?.isAdmin || !!this.auth.user()?.isAdmin),
  );

  readonly saving = signal(false);


  readonly formUsername = signal('');
  readonly formCurrentPassword = signal('');
  readonly formPassword = signal('');
  readonly formEmail = signal('');
  readonly formRoleId = signal<number | null>(null);
  readonly formIsAdmin = signal(false);
  readonly formEnabled = signal(true);
  readonly formRequirePasswordChange = signal(false);
  /** A Set for O(1) checkbox toggles; converted to a sorted array on save. */
  readonly formLibraryIds = signal<ReadonlySet<number>>(new Set());
  readonly libraries = signal<Library[]>([]);
  /** Request quotas as typed: a limit counts requests per period, 0 is unlimited. */
  readonly formQuotas = signal<Record<QuotaKey, number>>({
    movieQuotaLimit: 0,
    seriesQuotaLimit: 0,
    bookQuotaLimit: 0,
    quotaPeriodDays: 7,
  });
  protected readonly quotaKinds = [
    { key: 'movieQuotaLimit', label: 'requests.type_movie' },
    { key: 'seriesQuotaLimit', label: 'requests.type_series' },
    { key: 'bookQuotaLimit', label: 'kinds.book' },
  ] as const;

  ngOnInit() {
    const user = this.state.user();
    if (user) {
      this.formUsername.set(user.username);
      this.formRoleId.set(user.roleId);
      this.formIsAdmin.set(user.isAdmin ?? false);
      this.formEnabled.set(user.enabled);
      this.formRequirePasswordChange.set(user.requirePasswordChange ?? false);
      this.formLibraryIds.set(new Set(user.libraryIds ?? []));
      this.formQuotas.set({
        movieQuotaLimit: user.movieQuotaLimit ?? 0,
        seriesQuotaLimit: user.seriesQuotaLimit ?? 0,
        bookQuotaLimit: user.bookQuotaLimit ?? 0,
        quotaPeriodDays: user.quotaPeriodDays ?? 7,
      });
    }
    void this.loadLibraries();
  }

  private async loadLibraries() {
    try {
      this.libraries.set(await this.librariesApi.list());
    } catch {
      // Empty list is acceptable — admin can still save other fields.
    }
  }

  setQuota(key: QuotaKey, value: number | null) {
    const min = key === 'quotaPeriodDays' ? 1 : 0;
    this.formQuotas.update((q) => ({ ...q, [key]: Math.max(min, Math.floor(Number(value ?? min))) }));
  }

  /** Only the quota fields that changed: they need `users.manage`, which a plain edit must not demand. */
  private changedQuotas(user: UserRow): Partial<Record<QuotaKey, number>> {
    const form = this.formQuotas();
    const before: Record<QuotaKey, number> = {
      movieQuotaLimit: user.movieQuotaLimit ?? 0,
      seriesQuotaLimit: user.seriesQuotaLimit ?? 0,
      bookQuotaLimit: user.bookQuotaLimit ?? 0,
      quotaPeriodDays: user.quotaPeriodDays ?? 7,
    };
    return Object.fromEntries(QUOTA_KEYS.filter((k) => form[k] !== before[k]).map((k) => [k, form[k]]));
  }

  toggleLibrary(id: number, checked: boolean) {
    const next = new Set(this.formLibraryIds());
    if (checked) next.add(id);
    else next.delete(id);
    this.formLibraryIds.set(next);
  }

  isLibrarySelected(id: number): boolean {
    return this.formLibraryIds().has(id);
  }

  /** Revokes every session of the user. */
  async signOutEverywhere() {
    const user = this.state.user();
    if (!user) return;
    const ok = await this.confirmation.confirm({
      title: this.translate.instant('settings.users.sign_out_everywhere_title'),
      message: this.translate.instant('settings.users.sign_out_everywhere_message', { name: user.username }),
      confirmLabel: this.translate.instant('settings.users.sign_out_everywhere'),
      variant: 'danger',
    });
    if (!ok) return;
    try {
      await this.api.signOutEverywhere(user.id);
      this.toast.success(this.translate.instant('settings.users.signed_out', { name: user.username }));
    } catch {
      // Errors are surfaced by the global HTTP interceptor.
    }
  }

  async save() {
    const user = this.state.user();
    if (!user) return;
    this.saving.set(true);
    const body: UpdateUserBody = {
      username: this.formUsername().trim() || undefined,
      roleId: this.canAssignRole ? (this.formRoleId() ?? undefined) : undefined,
      isAdmin: this.formIsAdmin(),
      enabled: this.formEnabled(),
      requirePasswordChange: this.formRequirePasswordChange(),
      libraryIds: [...this.formLibraryIds()].sort((a, b) => a - b),
      ...this.changedQuotas(user),
    };
    if (this.formPassword()) {
      body.password = this.formPassword();
      if (this.isSelf() && this.formCurrentPassword()) body.currentPassword = this.formCurrentPassword();
    }
    const ownPassword = !!body.password && this.isSelf();
    try {
      const updated = await this.api.update(user.id, body, { skipErrorToast: ownPassword });
      this.state.user.set(updated);
      this.formCurrentPassword.set('');
      this.formPassword.set('');
      this.toast.success(this.translate.instant('settings.users.save_success'));
    } catch (err) {
      // The interceptor toasts every other failure; a wrong current password reads translated here.
      if (ownPassword) this.toast.error(passwordErrorMessage(err, this.translate));
    } finally {
      this.saving.set(false);
    }
  }
}
