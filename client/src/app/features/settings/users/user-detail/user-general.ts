import {
  Component,
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
} from '../../../../core/services/api/users-api.service';
import {
  LibrariesApiService,
  Library,
} from '../../../../core/services/api/libraries-api.service';
import { UserDetailState } from './user-detail.state';
import { ToastService } from '../../../../core/services/toast.service';
import { LucideIconComponent } from '../../../../shared/components/lucide-icon';

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

  readonly saving = signal(false);


  readonly formUsername = signal('');
  readonly formPassword = signal('');
  readonly formEmail = signal('');
  readonly formRoleId = signal<number | null>(null);
  readonly formIsAdmin = signal(false);
  readonly formEnabled = signal(true);
  readonly formRequirePasswordChange = signal(false);
  /**
   * Libraries the user can access. Stored as a Set so the template's
   * checkbox toggles are O(1) — converted to a sorted array on save.
   */
  readonly formLibraryIds = signal<ReadonlySet<number>>(new Set());
  readonly libraries = signal<Library[]>([]);

  ngOnInit() {
    const user = this.state.user();
    if (user) {
      this.formUsername.set(user.username);
      this.formRoleId.set(user.roleId);
      this.formIsAdmin.set(user.isAdmin ?? false);
      this.formEnabled.set(user.enabled);
      this.formRequirePasswordChange.set(user.requirePasswordChange ?? false);
      this.formLibraryIds.set(new Set(user.libraryIds ?? []));
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

  toggleLibrary(id: number, checked: boolean) {
    const next = new Set(this.formLibraryIds());
    if (checked) next.add(id);
    else next.delete(id);
    this.formLibraryIds.set(next);
  }

  isLibrarySelected(id: number): boolean {
    return this.formLibraryIds().has(id);
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
      requirePasswordChange: this.formRequirePasswordChange(),
      libraryIds: [...this.formLibraryIds()].sort((a, b) => a - b),
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
