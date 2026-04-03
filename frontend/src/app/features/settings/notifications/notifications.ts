import {
  Component,
  ChangeDetectionStrategy,
  ElementRef,
  signal,
  inject,
  OnInit,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import { ConfirmationService } from '../../../core/services/confirmation.service';

interface NotificationConnection {
  id: number;
  name: string;
  type: string;
  enabled: boolean;
  events: string[];
}

interface CreateNotificationBody {
  name: string;
  type: 'discord' | 'slack' | 'webhook' | 'gotify' | 'ntfy';
  settings: Record<string, unknown>;
  events?: string[];
  enabled?: boolean;
}

@Component({
  selector: 'app-notifications-settings',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './notifications.html',
})
export class NotificationsSettingsComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly editorDialog = viewChild<ElementRef<HTMLDialogElement>>('editorDialog');

  readonly rows = signal<NotificationConnection[]>([]);
  readonly loading = signal(true);
  readonly listError = signal('');
  readonly saving = signal(false);

  readonly editingId = signal<number | null>(null);
  readonly testLoading = signal(false);
  readonly testResult = signal<{ ok: boolean; message: string } | null>(null);

  readonly formName = signal('');
  readonly formType = signal<CreateNotificationBody['type']>('discord');
  readonly formEnabled = signal(true);
  readonly formWebhookUrl = signal('');
  readonly formToken = signal('');
  readonly formTopic = signal('');
  readonly formEvents = signal<string[]>([]);

  readonly allEvents = [
    'request.created',
    'request.approved',
    'request.declined',
    'grab.started',
    'download.complete',
    'health.issue',
  ];

  readonly connectionTypes = ['discord', 'slack', 'webhook', 'gotify', 'ntfy'] as const;

  ngOnInit() {
    this.reloadAll();
  }

  async reloadAll() {
    this.loading.set(true);
    try {
      const list = await firstValueFrom(
        this.http.get<NotificationConnection[]>('/api/notifications'),
      );
      this.rows.set(list);
    } catch {
      this.listError.set(this.translate.instant('settings.notifications.load_error'));
    } finally {
      this.loading.set(false);
    }
  }

  openCreate() {
    this.editingId.set(null);
    this.formName.set('');
    this.formType.set('discord');
    this.formEnabled.set(true);
    this.formWebhookUrl.set('');
    this.formToken.set('');
    this.formTopic.set('');
    this.formEvents.set([...this.allEvents]);
    this.testResult.set(null);
    this.editorDialog()?.nativeElement.showModal();
  }

  openEdit(nc: NotificationConnection) {
    this.editingId.set(nc.id);
    this.formName.set(nc.name);
    this.formType.set(nc.type as CreateNotificationBody['type']);
    this.formEnabled.set(nc.enabled);
    this.formWebhookUrl.set('');
    this.formToken.set('');
    this.formTopic.set('');
    this.formEvents.set([...nc.events]);
    this.testResult.set(null);
    this.editorDialog()?.nativeElement.showModal();
  }

  closeEditor() {
    this.editorDialog()?.nativeElement.close();
  }

  toggleEvent(event: string) {
    this.formEvents.update((evts) =>
      evts.includes(event) ? evts.filter((e) => e !== event) : [...evts, event],
    );
  }

  private buildSettings(): Record<string, unknown> {
    const type = this.formType();
    if (type === 'discord' || type === 'slack' || type === 'webhook') {
      return { webhookUrl: this.formWebhookUrl() };
    }
    if (type === 'gotify') {
      return { webhookUrl: this.formWebhookUrl(), token: this.formToken() };
    }
    if (type === 'ntfy') {
      return { webhookUrl: this.formWebhookUrl(), topic: this.formTopic() };
    }
    return {};
  }

  async testConnection() {
    const id = this.editingId();
    if (id == null) return;
    this.testLoading.set(true);
    this.testResult.set(null);
    try {
      const r = await firstValueFrom(
        this.http.post<{ ok: boolean; message: string }>(
          `/api/notifications/${id}/test`,
          {},
        ),
      );
      this.testResult.set(r);
    } catch {
      this.testResult.set({ ok: false, message: 'Connection test failed' });
    } finally {
      this.testLoading.set(false);
    }
  }

  async save() {
    const name = this.formName().trim();
    if (!name) return;
    this.saving.set(true);
    const body: CreateNotificationBody = {
      name,
      type: this.formType(),
      settings: this.buildSettings(),
      events: this.formEvents(),
      enabled: this.formEnabled(),
    };
    const id = this.editingId();
    try {
      await (id == null
        ? firstValueFrom(this.http.post<NotificationConnection>('/api/notifications', body))
        : firstValueFrom(this.http.put<NotificationConnection>(`/api/notifications/${id}`, body)));
      this.closeEditor();
      await this.reloadAll();
    } catch {
      // handled by global error interceptor
    } finally {
      this.saving.set(false);
    }
  }

  async deleteRow(nc: NotificationConnection) {
    if (!await this.confirmation.confirm({ title: this.translate.instant('common.confirm'), message: this.translate.instant('settings.notifications.confirm_delete', { name: nc.name }), variant: 'danger' })) return;
    try {
      await firstValueFrom(this.http.delete(`/api/notifications/${nc.id}`));
      await this.reloadAll();
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      void this.confirmation.alert({ title: this.translate.instant('common.error'), message: httpErr.error?.message ?? 'Error', variant: 'danger' });
    }
  }
}
