import {
  Component,
  ChangeDetectionStrategy,
  signal,
  computed,
  inject,
  OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import {
  MediaServersApiService,
  MediaServerRow,
  MediaServerTypeInfo,
} from '../../../core/services/api/media-servers-api.service';

@Component({
  selector: 'app-media-servers-settings',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-servers.html',
})
export class MediaServersSettingsComponent implements OnInit {
  private readonly api = inject(MediaServersApiService);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);

  readonly serverTypes = signal<MediaServerTypeInfo[]>([]);
  readonly rows = signal<MediaServerRow[]>([]);
  readonly loading = signal(true);
  readonly listError = signal('');

  readonly editorOpen = signal(false);
  readonly saving = signal(false);
  readonly saveError = signal('');
  readonly editingId = signal<number | null>(null);
  readonly testLoading = signal(false);
  readonly testResult = signal<{ ok: boolean; message: string } | null>(null);

  readonly formName = signal('');
  readonly formType = signal('emby');
  readonly formUrl = signal('');
  readonly formApiKey = signal('');
  readonly formEnabled = signal(true);
  readonly formEvents = signal<string[]>([]);

  /** Events available for the currently selected type. */
  readonly currentSupportedEvents = computed(() => {
    const type = this.formType();
    const info = this.serverTypes().find((t) => t.type === type);
    return info?.supportedEvents ?? [];
  });

  ngOnInit() {
    this.api.getTypes().then((types) => this.serverTypes.set(types));
    this.reloadAll();
  }

  async reloadAll() {
    this.loading.set(true);
    this.listError.set('');
    try {
      this.rows.set(await this.api.list());
    } catch {
      this.listError.set(this.translate.instant('settings.media_servers.load_error'));
    } finally {
      this.loading.set(false);
    }
  }

  typeLabel(type: string): string {
    return this.serverTypes().find((t) => t.type === type)?.label ?? type;
  }

  openCreate() {
    this.editingId.set(null);
    const firstType = this.serverTypes()[0]?.type ?? 'emby';
    this.formType.set(firstType);
    this.formName.set(this.typeLabel(firstType));
    this.formUrl.set('');
    this.formApiKey.set('');
    this.formEnabled.set(true);
    this.formEvents.set([...(this.serverTypes()[0]?.supportedEvents ?? [])]);
    this.saveError.set('');
    this.testResult.set(null);
    this.editorOpen.set(true);
  }

  openEdit(row: MediaServerRow) {
    this.editingId.set(row.id);
    this.formName.set(row.name);
    this.formType.set(row.type);
    this.formUrl.set(row.url);
    this.formApiKey.set(row.apiKey);
    this.formEnabled.set(row.enabled);
    this.formEvents.set([...row.events]);
    this.saveError.set('');
    this.testResult.set(null);
    this.editorOpen.set(true);
  }

  closeEditor() {
    this.editorOpen.set(false);
  }

  onTypeChange(type: string) {
    this.formType.set(type);
    if (this.editingId() === null) {
      this.formName.set(this.typeLabel(type));
    }
    // Reset events to all supported for this type
    const info = this.serverTypes().find((t) => t.type === type);
    this.formEvents.set([...(info?.supportedEvents ?? [])]);
  }

  toggleEvent(event: string) {
    this.formEvents.update((evts) =>
      evts.includes(event) ? evts.filter((e) => e !== event) : [...evts, event],
    );
  }

  async testConnection() {
    const id = this.editingId();
    if (id == null) return;
    this.testLoading.set(true);
    this.testResult.set(null);
    try {
      const r = await this.api.testConnection(id);
      this.testResult.set(r);
    } catch {
      this.testResult.set({ ok: false, message: this.translate.instant('settings.media_servers.test_error') });
    } finally {
      this.testLoading.set(false);
    }
  }

  async save() {
    const name = this.formName().trim();
    if (!name) {
      this.saveError.set(this.translate.instant('settings.media_servers.name_required'));
      return;
    }
    const url = this.formUrl().trim();
    if (!url) {
      this.saveError.set(this.translate.instant('settings.media_servers.url_required'));
      return;
    }

    const body = {
      name,
      type: this.formType(),
      url: url.replace(/\/$/, ''),
      apiKey: this.formApiKey().trim(),
      events: this.formEvents(),
      enabled: this.formEnabled(),
    };

    this.saving.set(true);
    this.saveError.set('');
    const id = this.editingId();
    try {
      await (id == null ? this.api.create(body) : this.api.update(id, body));
      this.closeEditor();
      await this.reloadAll();
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string | string[] } };
      const msg = Array.isArray(httpErr.error?.message)
        ? httpErr.error.message.join(', ')
        : httpErr.error?.message;
      this.saveError.set(msg ?? this.translate.instant('settings.media_servers.save_error'));
    } finally {
      this.saving.set(false);
    }
  }

  async deleteRow(row: MediaServerRow) {
    if (!await this.confirmation.confirm({
      title: this.translate.instant('common.confirm'),
      message: this.translate.instant('settings.media_servers.confirm_delete', { name: row.name }),
      variant: 'danger',
    })) return;
    try {
      await this.api.remove(row.id);
      await this.reloadAll();
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      void this.confirmation.alert({
        title: this.translate.instant('common.error'),
        message: httpErr.error?.message ?? 'Error',
        variant: 'danger',
      });
    }
  }
}
