import { Component, computed, inject, signal } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import type { MediaType } from '../../../core/enums/media-type.enum';
import { KIND_REGISTRY, MEDIA_KINDS } from '../../../core/media-kinds';
import { UpdateUserBody, UsersApiService } from '../../../core/services/api/users-api.service';
import { AuthService } from '../../../core/services/auth.service';
import { ToastService } from '../../../core/services/toast.service';
import { ToggleFieldComponent } from '../../../shared/components/forms/toggle-field/toggle-field';

/** Kinds a reader opens at the last known place: no exclusivity, no remote control. */
const RESUME_ONLY: readonly MediaType[] = ['book', 'comic'];

/** Account setting: one playback at a time, followed and taken over from any device. */
@Component({
  selector: 'app-session-sync-settings',
  imports: [TranslatePipe, ToggleFieldComponent],
  templateUrl: './session-sync-settings.html',
})
export class SessionSyncSettingsComponent {
  private readonly api = inject(UsersApiService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly kinds = MEDIA_KINDS;
  protected readonly enabled = signal(false);
  /** null covers every kind, as on the account. */
  protected readonly chosen = signal<MediaType[] | null>(null);
  protected readonly scopeAll = computed(() => this.chosen() === null);

  constructor() {
    this.syncFromUser();
  }

  protected label(kind: MediaType): string {
    return this.translate.instant(KIND_REGISTRY[kind].requestLabelKey);
  }

  protected resumeOnly(kind: MediaType): boolean {
    return RESUME_ONLY.includes(kind);
  }

  protected isChosen(kind: MediaType): boolean {
    return this.chosen()?.includes(kind) ?? false;
  }

  protected async setEnabled(value: boolean): Promise<void> {
    this.enabled.set(value);
    await this.persist({ sessionSync: value });
  }

  protected async setScope(all: boolean): Promise<void> {
    if (all === this.scopeAll()) return;
    const next = all ? null : [...MEDIA_KINDS];
    this.chosen.set(next);
    await this.persist({ sessionKinds: next });
  }

  /** The last chosen kind stays: an empty list would cover nothing while the switch reads on. */
  protected async toggleKind(kind: MediaType): Promise<void> {
    const cur = this.chosen();
    if (!cur) return;
    const next = cur.includes(kind) ? cur.filter((k) => k !== kind) : MEDIA_KINDS.filter((k) => k === kind || cur.includes(k));
    if (next.length === 0) return;
    this.chosen.set(next);
    await this.persist({ sessionKinds: next });
  }

  /** (Re)seeds from the auth user; also reverts a failed save. */
  private syncFromUser(): void {
    const u = this.auth.user();
    this.enabled.set(u?.sessionSync === true);
    this.chosen.set(u?.sessionKinds ?? null);
  }

  private async persist(patch: UpdateUserBody): Promise<void> {
    const user = this.auth.user();
    if (!user) return;
    try {
      await this.api.update(user.id, patch);
      this.auth.patchUser(patch);
      this.toast.success(this.translate.instant('session.saved'));
    } catch {
      this.syncFromUser();
    }
  }
}
