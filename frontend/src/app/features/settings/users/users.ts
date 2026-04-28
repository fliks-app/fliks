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
import { RouterLink } from '@angular/router';
import { LucideX } from '@lucide/angular';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  UsersApiService,
  UserRow,
  CreateUserBody,
} from '../../../core/services/api/users-api.service';
import { RolesApiService, RoleRow } from '../../../core/services/api/roles-api.service';
import { LibrariesApiService, Library } from '../../../core/services/api/libraries-api.service';
import { AuthService } from '../../../core/services/auth.service';
import { ToastService } from '../../../core/services/toast.service';

@Component({
  selector: 'app-users-settings',
  imports: [FormsModule, LucideX, RouterLink, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './users.html',
})
export class UsersSettingsComponent implements OnInit {
  private readonly api = inject(UsersApiService);
  private readonly rolesApi = inject(RolesApiService);
  private readonly librariesApi = inject(LibrariesApiService);
  private readonly translate = inject(TranslateService);
  readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly editorDialog = viewChild<ElementRef<HTMLDialogElement>>('editorDialog');

  readonly rows = signal<UserRow[]>([]);
  readonly roles = signal<RoleRow[]>([]);
  readonly libraries = signal<Library[]>([]);
  readonly loading = signal(true);
  readonly listError = signal('');

  readonly saving = signal(false);

  readonly formUsername = signal('');
  readonly formPassword = signal('');
  readonly formEmail = signal('');
  readonly formRoleId = signal<number | null>(null);
  readonly formEnabled = signal(true);
  readonly formLibraryIds = signal<Set<number>>(new Set());

  ngOnInit() {
    this.reloadAll();
  }

  async reloadAll() {
    this.loading.set(true);
    try {
      const [list, roles, libraries] = await Promise.all([
        this.api.list(),
        this.rolesApi.list(),
        this.librariesApi.list(),
      ]);
      this.rows.set(list);
      this.roles.set(roles);
      this.libraries.set(libraries);
    } catch {
      this.listError.set(this.translate.instant('settings.users.load_error'));
    } finally {
      this.loading.set(false);
    }
  }

  toggleLibrary(id: number) {
    this.formLibraryIds.update((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  openCreate() {
    this.formUsername.set('');
    this.formPassword.set('');
    this.formEmail.set('');
    const defaultRole = this.roles().find((r) => r.isDefault);
    this.formRoleId.set(defaultRole?.id ?? this.roles()[0]?.id ?? null);
    this.formEnabled.set(true);
    // Seed with the default role's library template if any.
    const templateIds = (defaultRole as RoleRow & { defaultLibraryIds?: number[] })
      ?.defaultLibraryIds;
    this.formLibraryIds.set(new Set(templateIds ?? []));
    this.editorDialog()?.nativeElement.showModal();
  }

  closeEditor() {
    this.editorDialog()?.nativeElement.close();
  }

  /**
   * Render `lastLogin` as a relative time string for the table. Uses the
   * Intl.RelativeTimeFormat API so the locale follows the active translate
   * lang automatically.
   */
  formatLastLogin(iso: string): string {
    const diffMs = Date.now() - new Date(iso).getTime();
    const minutes = Math.round(diffMs / 60000);
    const fmt = new Intl.RelativeTimeFormat(this.translate.currentLang ?? 'fr', { numeric: 'auto' });
    if (minutes < 1) return fmt.format(0, 'minute');
    if (minutes < 60) return fmt.format(-minutes, 'minute');
    const hours = Math.round(minutes / 60);
    if (hours < 24) return fmt.format(-hours, 'hour');
    const days = Math.round(hours / 24);
    if (days < 30) return fmt.format(-days, 'day');
    const months = Math.round(days / 30);
    if (months < 12) return fmt.format(-months, 'month');
    return fmt.format(-Math.round(months / 12), 'year');
  }

  /** Modal is create-only — edits go through the dedicated /admin/users/:id page. */
  async save() {
    this.saving.set(true);
    try {
      const body: CreateUserBody = {
        username: this.formUsername().trim(),
        password: this.formPassword(),
        roleId: this.formRoleId() ?? undefined,
        enabled: this.formEnabled(),
        libraryIds: [...this.formLibraryIds()],
      };
      if (this.formEmail().trim()) body.email = this.formEmail().trim();
      await this.api.create(body);
      this.closeEditor();
      this.toast.success(this.translate.instant('settings.users.save_success'));
      await this.reloadAll();
    } catch {
      // handled by global error interceptor
    } finally {
      this.saving.set(false);
    }
  }

}
