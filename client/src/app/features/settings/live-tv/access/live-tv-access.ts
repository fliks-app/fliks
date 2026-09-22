import { Component, ElementRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ToastService } from '../../../../core/services/toast.service';
import { LiveTvApiService } from '../../../../core/services/api/livetv-api.service';
import { UsersApiService, UserRow } from '../../../../core/services/api/users-api.service';
import { EnabledSwitchComponent } from '../../../../shared/components/enabled-switch';
import { ModalHeaderComponent } from '../../../../shared/components/modal-header';
import { ModalFooterComponent } from '../../../../shared/components/modal-footer';

/** Mirrors the backend's own heuristic (`ADULT_GROUP_PATTERN` in
 *  livetv-access.service.ts): a display hint only, never authoritative. */
const ADULT_GROUP_PATTERN = /\b(xxx|adult|porn|erotic|18\+|hot)\b/i;

interface GroupFacet {
  name: string;
  count: number;
}

@Component({
  selector: 'app-live-tv-access',
  imports: [TranslatePipe, EnabledSwitchComponent, ModalHeaderComponent, ModalFooterComponent],
  templateUrl: './live-tv-access.html',
})
export class LiveTvAccessComponent implements OnInit {
  private readonly api = inject(LiveTvApiService);
  private readonly usersApi = inject(UsersApiService);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);
  private readonly grantsDialog = viewChild<ElementRef<HTMLDialogElement>>('grantsDialog');

  readonly loading = signal(true);
  private readonly groups = signal<GroupFacet[]>([]);
  readonly restricted = signal<Set<string>>(new Set());
  readonly togglingGroup = signal<string | null>(null);

  /** The restricted-groups setting can outlive the group itself (source removed,
   *  provider renamed it): shown with a 0 count rather than silently dropped. */
  readonly displayGroups = computed<GroupFacet[]>(() => {
    const byName = new Map(this.groups().map((g) => [g.name, g]));
    for (const name of this.restricted()) {
      if (!byName.has(name)) byName.set(name, { name, count: 0 });
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  });

  /** `@for` needs an array, not the `Set` the toggle logic is built around. */
  readonly restrictedList = computed(() =>
    [...this.restricted()].sort((a, b) => a.localeCompare(b)),
  );

  readonly users = signal<UserRow[]>([]);

  readonly grantsUser = signal<UserRow | null>(null);
  readonly grantsLoading = signal(false);
  readonly grantsSaving = signal(false);
  readonly grantedGroups = signal<Set<string>>(new Set());

  async ngOnInit(): Promise<void> {
    this.loading.set(true);
    // allSettled: an admin who can manage Live TV but not Users still gets the
    // restricted-groups half; only the per-user grants stay empty for them.
    const [groupsResult, restrictedResult, usersResult] = await Promise.allSettled([
      this.api.listAdminChannels({ page: 1, pageSize: 1 }),
      this.api.getRestrictedGroups(),
      this.usersApi.list(),
    ]);
    if (groupsResult.status === 'fulfilled') this.groups.set(groupsResult.value.groups ?? []);
    if (restrictedResult.status === 'fulfilled')
      this.restricted.set(new Set(restrictedResult.value));
    if (usersResult.status === 'fulfilled') this.users.set(usersResult.value);
    this.loading.set(false);
  }

  isAdultMatch(name: string): boolean {
    return ADULT_GROUP_PATTERN.test(name);
  }

  async toggleRestricted(name: string): Promise<void> {
    const next = new Set(this.restricted());
    if (!next.delete(name)) next.add(name);
    this.togglingGroup.set(name);
    try {
      const saved = await this.api.setRestrictedGroups([...next]);
      this.restricted.set(new Set(saved));
    } catch {
      // handled by global error interceptor
    } finally {
      this.togglingGroup.set(null);
    }
  }

  openGrants(user: UserRow): void {
    this.grantsUser.set(user);
    this.grantedGroups.set(new Set());
    this.grantsDialog()?.nativeElement.showModal();
    this.grantsLoading.set(true);
    this.api
      .getUserGroupGrants(user.id)
      .then((groups) => this.grantedGroups.set(new Set(groups)))
      .catch(() => {
        // handled by global error interceptor
      })
      .finally(() => this.grantsLoading.set(false));
  }

  closeGrants(): void {
    this.grantsDialog()?.nativeElement.close();
  }

  toggleGrant(name: string): void {
    this.grantedGroups.update((s) => {
      const next = new Set(s);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  }

  async saveGrants(): Promise<void> {
    const user = this.grantsUser();
    if (!user) return;
    this.grantsSaving.set(true);
    try {
      await this.api.setUserGroupGrants(user.id, [...this.grantedGroups()]);
      this.toast.success(this.translate.instant('liveTv.admin.access.grants_saved'));
      this.closeGrants();
    } catch {
      // handled by global error interceptor
    } finally {
      this.grantsSaving.set(false);
    }
  }
}
