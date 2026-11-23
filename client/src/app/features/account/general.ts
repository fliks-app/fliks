import { Component, computed, inject, signal, OnInit } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucideDynamicIcon } from '@lucide/angular';
import type { MediaType } from '../../core/enums/media-type.enum';
import { KIND_REGISTRY, MEDIA_KINDS } from '../../core/media-kinds';
import { translatePlural } from '../../core/pipes/translate-plural.pipe';
import { StreamingApiService } from '../../core/services/api/streaming-api.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { UpdateUserBody, UsersApiService } from '../../core/services/api/users-api.service';
import { AuthService } from '../../core/services/auth.service';
import { SERVER_SINCE, ServerVersionService } from '../../core/services/server-version.service';
import { ToastService } from '../../core/services/toast.service';
import { ToggleFieldComponent } from '../../shared/components/forms/toggle-field/toggle-field';
import { icons } from '../../shared/icons';

/** Kinds a reader opens at the last known place: no exclusivity, no remote control. */
const RESUME_ONLY: readonly MediaType[] = ['book', 'comic'];

/** Account settings: what's new, one playback followed from any device, and undoing dismissed recommendations. */
@Component({
  selector: 'app-account-general',
  imports: [TranslatePipe, ToggleFieldComponent, LucideDynamicIcon],
  templateUrl: './general.html',
})
export class AccountGeneralComponent implements OnInit {
  protected readonly icons = icons;

  private readonly api = inject(UsersApiService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly versions = inject(ServerVersionService);
  private readonly streaming = inject(StreamingApiService);
  private readonly confirmation = inject(ConfirmationService);

  protected readonly showWhatsNew = computed(() => this.versions.supports(SERVER_SINCE.whatsNew));
  protected readonly showSessionSync = computed(() => this.versions.supports(SERVER_SINCE.sessionSync));

  protected readonly kinds = MEDIA_KINDS;
  protected readonly whatsNew = signal(true);
  protected readonly enabled = signal(false);
  /** null covers every kind, as on the account. */
  protected readonly chosen = signal<MediaType[] | null>(null);
  protected readonly scopeAll = computed(() => this.chosen() === null);
  protected readonly dismissed = signal<number | null>(null);
  protected readonly resetting = signal(false);

  constructor() {
    this.syncFromUser();
  }

  ngOnInit() {
    void this.streaming.countDismissedRecommendations().then(
      (res) => this.dismissed.set(res.count),
      () => this.dismissed.set(0),
    );
  }

  protected async resetDismissed(): Promise<void> {
    const count = this.dismissed() ?? 0;
    if (!count) return;
    const ok = await this.confirmation.confirm({
      title: this.translate.instant('account_settings.recommendations.confirm_title'),
      message: translatePlural(this.translate, 'account_settings.recommendations.confirm_body', count),
      confirmLabel: this.translate.instant('account_settings.recommendations.reset'),
    });
    if (!ok) return;
    this.resetting.set(true);
    try {
      const res = await this.streaming.resetDismissedRecommendations();
      this.toast.success(translatePlural(this.translate, 'account_settings.recommendations.reset_success', res.removed));
      this.dismissed.set(0);
    } catch {
      // The global interceptor reports it.
    } finally {
      this.resetting.set(false);
    }
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

  protected async setWhatsNew(value: boolean): Promise<void> {
    this.whatsNew.set(value);
    await this.persist({ whatsNewEnabled: value });
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
    this.whatsNew.set(u?.whatsNewEnabled ?? true);
    this.enabled.set(u?.sessionSync === true);
    this.chosen.set(u?.sessionKinds ?? null);
  }

  private async persist(patch: UpdateUserBody): Promise<void> {
    const user = this.auth.user();
    if (!user) return;
    try {
      await this.api.update(user.id, patch);
      this.auth.patchUser(patch);
      this.toast.success(this.translate.instant('common.saved'));
    } catch {
      this.syncFromUser();
    }
  }
}
