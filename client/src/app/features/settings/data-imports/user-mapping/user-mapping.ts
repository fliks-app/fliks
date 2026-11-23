import { Component, effect, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { TvSelectDirective } from '../../../../shared/directives/tv-select.directive';
import { ModalComponent } from '../../../../shared/components/modal';
import { ModalFooterComponent } from '../../../../shared/components/modal-footer';
import { ModalHeaderComponent } from '../../../../shared/components/modal-header';
import { ToastService } from '../../../../core/services/toast.service';
import { UsersApiService, type UserRow } from '../../../../core/services/api/users-api.service';
import { serverMessage } from '../../../../core/utils/server-message';

/** An external user an import skipped because a Fliks account already holds its name. */
export interface UnmappedUser {
  provider: string;
  externalId: string;
  username: string;
}

/** The picker's value for "make a new account for this user". */
export const NEW_ACCOUNT = '__new__';

export function unmappedKey(u: UnmappedUser): string {
  return `${u.provider}|${u.externalId}`;
}

@Component({
  selector: 'app-import-user-mapping',
  imports: [FormsModule, TranslatePipe, TvSelectDirective, ModalComponent, ModalFooterComponent, ModalHeaderComponent],
  templateUrl: './user-mapping.html',
})
export class ImportUserMappingComponent {
  private readonly usersApi = inject(UsersApiService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  readonly users = input.required<UnmappedUser[]>();
  readonly shown = input(false);
  readonly closed = output<void>();
  /** One external user is bound; the parent drops it from its list. */
  readonly mapped = output<UnmappedUser>();

  protected readonly NEW_ACCOUNT = NEW_ACCOUNT;
  protected readonly key = unmappedKey;
  protected readonly accounts = signal<UserRow[]>([]);
  protected readonly choice = signal<Record<string, string>>({});
  protected readonly newName = signal<Record<string, string>>({});
  protected readonly busy = signal<string | null>(null);

  constructor() {
    effect(() => {
      if (this.shown()) void this.loadAccounts();
    });
  }

  private async loadAccounts(): Promise<void> {
    try {
      this.accounts.set(await this.usersApi.list());
    } catch {
      // the error toast comes from the global interceptor
    }
  }

  protected setChoice(u: UnmappedUser, value: string): void {
    this.choice.update((c) => ({ ...c, [unmappedKey(u)]: value }));
  }

  protected setNewName(u: UnmappedUser, value: string): void {
    this.newName.update((c) => ({ ...c, [unmappedKey(u)]: value }));
  }

  protected canMap(u: UnmappedUser): boolean {
    const choice = this.choice()[unmappedKey(u)];
    if (!choice) return false;
    return choice !== NEW_ACCOUNT || !!this.newName()[unmappedKey(u)]?.trim();
  }

  protected async map(u: UnmappedUser): Promise<void> {
    const k = unmappedKey(u);
    const choice = this.choice()[k];
    if (!choice || this.busy()) return;
    this.busy.set(k);
    try {
      const userId =
        choice === NEW_ACCOUNT
          ? (await this.usersApi.create({ username: this.newName()[k].trim() })).id
          : Number(choice);
      await this.usersApi.mapImported({ provider: u.provider, externalId: u.externalId, userId });
      this.toast.success(this.translate.instant('settings.data_imports.user_mapping.mapped', { name: u.username }));
      this.mapped.emit(u);
    } catch (e) {
      this.toast.error(serverMessage(e, this.translate, 'settings.data_imports.user_mapping.error'));
    } finally {
      this.busy.set(null);
    }
  }
}
