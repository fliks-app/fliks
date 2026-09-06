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
import { TvSelectDirective } from '../../../shared/directives/tv-select.directive';
import { RouterLink } from '@angular/router';
import { LucideX } from '@lucide/angular';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
  UsersApiService,
  UserRow,
  CreateUserBody,
} from '../../../core/services/api/users-api.service';
import { RolesApiService, RoleRow } from '../../../core/services/api/roles-api.service';
import { LibrariesApiService, Library } from '../../../core/services/api/libraries-api.service';
import { AuthService } from '../../../core/services/auth.service';
import { ToastService } from '../../../core/services/toast.service';
import { formatRelativeTime } from '../../../core/utils/relative-time';
import { ModalHeaderComponent } from '../../../shared/components/modal-header';
import { ModalFooterComponent } from '../../../shared/components/modal-footer';

@Component({
  selector: 'app-users-settings',
  imports: [TvSelectDirective, ModalFooterComponent, ModalHeaderComponent, FormsModule, RouterLink, TranslatePipe],
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

  formatLastLogin(iso: string): string {
    return formatRelativeTime(iso, this.translate.currentLang() ?? 'fr');
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
