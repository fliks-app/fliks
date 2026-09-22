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
import { LocaleDatePipe } from '../../../../core/pipes/locale-date.pipe';

interface GroupFacet {
  name: string;
  count: number;
}

interface DisplayGroupFacet extends GroupFacet {
  /** Set once the group is missing from a confirmed-complete sync: when its
   *  access actually gets dropped if it stays gone. */
  cleanupAt: string | null;
}

@Component({
  selector: 'app-live-tv-access',
  imports: [
    TranslatePipe,
    LocaleDatePipe,
    EnabledSwitchComponent,
    ModalHeaderComponent,
    ModalFooterComponent,
  ],
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
  /** Auto-matched groups an admin deliberately unrestricted: open today, but the
   *  next sync still won't touch them — distinct from a plain unchecked group. */
  readonly exempt = signal<Set<string>>(new Set());
  /** Restricted groups missing from the live lineup, mapped to when their access clears. */
  readonly vanishing = signal<Map<string, string>>(new Map());
  readonly togglingGroups = signal<Set<string>>(new Set());
  /** Chains every save after the one before it: two toggles fired before the
   *  first resolves must not both read the same stale snapshot, or the second
   *  full-list replacement silently drops the first toggle's change. */
  private pendingSave: Promise<void> = Promise.resolve();

  /** The restricted-groups setting can outlive the group itself (source removed,
   *  provider renamed it): shown with a 0 count rather than silently dropped. */
  readonly displayGroups = computed<DisplayGroupFacet[]>(() => {
    const vanishing = this.vanishing();
    const byName = new Map(
      this.groups().map((g) => [g.name, { ...g, cleanupAt: vanishing.get(g.name) ?? null }]),
    );
    for (const name of new Set([...this.restricted(), ...this.exempt()])) {
      if (!byName.has(name)) {
        byName.set(name, { name, count: 0, cleanupAt: vanishing.get(name) ?? null });
      }
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
      const [channelsPage, accessView, users] = await Promise.all([
        this.api.listAdminChannels({ page: 1, pageSize: 1 }),
        this.api.getRestrictedGroups(),
        this.api.listUserAccess(),
      ]);
      this.groups.set(channelsPage.groups ?? []);
      this.restricted.set(new Set(accessView.groups.map((g) => g.name)));
      this.autoRestricted.set(
        new Set(accessView.groups.filter((g) => g.automatic).map((g) => g.name)),
      );
      this.vanishing.set(
        new Map(
          accessView.groups
            .filter((g) => g.cleanupAt != null)
            .map((g) => [g.name, g.cleanupAt as string]),
        ),
      );
      this.exempt.set(new Set(accessView.exempt));
      this.users.set(users);
    } catch {
      // handled by global error interceptor
    } finally {
      this.loading.set(false);
    }
  }

  toggleRestricted(name: string): Promise<void> {
    this.togglingGroups.update((s) => new Set(s).add(name));
    const run = this.pendingSave.then(async () => {
      const next = new Set(this.restricted());
      const isUnrestricting = next.delete(name);
      if (!isUnrestricting) next.add(name);
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
        this.togglingGroups.update((s) => {
          const next = new Set(s);
          next.delete(name);
          return next;
        });
      }
    });
    this.pendingSave = run;
    return run;
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
        list.map((u) => (u.id === user.id ? { ...u, groups: saved.groups } : u)),
      );
      if (saved.ignored.length) {
        this.toast.warning(
          this.translate.instant('liveTv.admin.access.grants_ignored', {
            groups: saved.ignored.join(', '),
          }),
        );
      } else {
        this.toast.success(this.translate.instant('liveTv.admin.access.grants_saved'));
      }
      this.closeGrants();
    } catch {
      // handled by global error interceptor
    } finally {
      this.grantsSaving.set(false);
    }
  }
}
