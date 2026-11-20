import { Component, computed, inject, signal } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { UsersApiService } from '../../../core/services/api/users-api.service';
import { AuthService } from '../../../core/services/auth.service';
import { PushService } from '../../../core/services/push.service';
import { ToastService } from '../../../core/services/toast.service';
import { TvService } from '../../../core/services/tv.service';
import { ToggleFieldComponent } from '../../../shared/components/forms/toggle-field/toggle-field';

/** Categories every account can mute; the server owns the vocabulary (`fliks_domain::push`). */
const CATEGORIES = ['requests', 'parties', 'social', 'episodes', 'account'] as const;

/** What reaches this account and this device: categories apply to every device, the switch to this one. */
@Component({
  selector: 'app-notification-settings',
  imports: [TranslatePipe, ToggleFieldComponent],
  templateUrl: './notification-settings.html',
})
export class NotificationSettingsPageComponent {
  protected readonly push = inject(PushService);
  private readonly auth = inject(AuthService);
  private readonly users = inject(UsersApiService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  protected readonly isTv = inject(TvService).isTv;

  protected readonly categories = CATEGORIES;
  protected readonly muted = computed(() => this.auth.user()?.pushMuted ?? []);
  protected readonly testing = signal(false);
  /** The browser refused the permission: only its site settings can undo that. */
  protected readonly denied = computed(() => this.push.permission() === 'denied');

  constructor() {
    void this.push.loadConfig();
  }

  protected async setDevice(on: boolean): Promise<void> {
    if (on) await this.push.enable();
    else await this.push.disable();
  }

  protected async setPluginMuted(id: string, on: boolean): Promise<void> {
    await this.setCategory(`plugin.${id}`, on);
  }

  protected async setCategory(cat: string, on: boolean): Promise<void> {
    const user = this.auth.user();
    if (!user) return;
    const current = this.muted();
    const next = on ? current.filter((c) => c !== cat) : [...current.filter((c) => c !== cat), cat];
    try {
      await this.users.update(user.id, { pushMuted: next });
      this.auth.patchUser({ pushMuted: next });
    } catch {
      // the global error interceptor already said so; the switch reads the unchanged account
    }
  }

  protected async test(): Promise<void> {
    this.testing.set(true);
    try {
      const results = await this.push.sendTest();
      const failed = results.filter((r) => !r.ok);
      if (failed.length) this.toast.error(this.translate.instant('app_settings.notifications.test_failed', { error: failed[0].error ?? '' }));
      else if (this.isTv()) return;
      else if (!results.length) this.toast.info(this.translate.instant('app_settings.notifications.test_none'));
      else this.toast.success(this.translate.instant('app_settings.notifications.test_sent'));
    } catch {
      // handled by the global error interceptor
    } finally {
      this.testing.set(false);
    }
  }
}
