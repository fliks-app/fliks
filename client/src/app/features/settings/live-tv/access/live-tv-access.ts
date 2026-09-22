import { Component, ElementRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ToastService } from '../../../../core/services/toast.service';
import {
  LiveTvApiService,
  LiveTvUserAccess,
} from '../../../../core/services/api/livetv-api.service';
import { EnabledSwitchComponent } from '../../../../shared/components/enabled-switch';
import { ModalHeaderComponent } from '../../../../shared/components/modal-header';
import { ModalFooterComponent } from '../../../../shared/components/modal-footer';

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
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);
  private readonly grantsDialog = viewChild<ElementRef<HTMLDialogElement>>('grantsDialog');

  readonly loading = signal(true);
  private readonly groups = signal<GroupFacet[]>([]);
  readonly restricted = signal<Set<string>>(new Set());
  /** Restricted groups whose name still matches the server's automatic adult-content pattern. */
  readonly autoRestricted = signal<Set<string>>(new Set());
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

  readonly users = signal<LiveTvUserAccess[]>([]);

  readonly grantsUser = signal<LiveTvUserAccess | null>(null);
  readonly grantsSaving = signal(false);
  readonly grantedGroups = signal<Set<string>>(new Set());

  async ngOnInit(): Promise<void> {
    this.loading.set(true);
    try {
      const [channelsPage, restrictedGroups, users] = await Promise.all([
        this.api.listAdminChannels({ page: 1, pageSize: 1 }),
        this.api.getRestrictedGroups(),
        this.api.listUserAccess(),
      ]);
      this.groups.set(channelsPage.groups ?? []);
      this.restricted.set(new Set(restrictedGroups.map((g) => g.name)));
      this.autoRestricted.set(
        new Set(restrictedGroups.filter((g) => g.automatic).map((g) => g.name)),
      );
      this.users.set(users);
    } catch {
      // handled by global error interceptor
    } finally {
      this.loading.set(false);
    }
  }

  async toggleRestricted(name: string): Promise<void> {
    const next = new Set(this.restricted());
    const isUnrestricting = next.delete(name);
    if (!isUnrestricting) next.add(name);
    this.togglingGroup.set(name);
    try {
      const saved = await this.api.setRestrictedGroups([...next]);
      this.restricted.set(new Set(saved));
      if (isUnrestricting && !saved.includes(name)) {
        // The server just dropped every grant for this group; mirror that here
        // instead of an extra listUserAccess() round trip.
        this.users.update((list) =>
          list.map((u) => ({ ...u, groups: u.groups.filter((g) => g !== name) })),
        );
      }
    } catch {
      // handled by global error interceptor
    } finally {
      this.togglingGroup.set(null);
    }
  }

  openGrants(user: LiveTvUserAccess): void {
    this.grantsUser.set(user);
    this.grantedGroups.set(new Set(user.groups));
    this.grantsDialog()?.nativeElement.showModal();
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
      const saved = await this.api.setUserGroupGrants(user.id, [...this.grantedGroups()]);
      this.users.update((list) =>
        list.map((u) => (u.id === user.id ? { ...u, groups: saved } : u)),
      );
      this.toast.success(this.translate.instant('liveTv.admin.access.grants_saved'));
      this.closeGrants();
    } catch {
      // handled by global error interceptor
    } finally {
      this.grantsSaving.set(false);
    }
  }
}
