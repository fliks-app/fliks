import {
  Component,
  ChangeDetectionStrategy,
  signal,
  inject,
  OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  RemotePathMappingsApiService,
  RemotePathMapping,
} from '../../../core/services/api/remote-path-mappings-api.service';
import {
  DownloadClientsApiService,
  DownloadClientRow,
} from '../../../core/services/api/download-clients-api.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';

@Component({
  selector: 'app-remote-path-mappings-settings',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './remote-path-mappings.html',
})
export class RemotePathMappingsSettingsComponent implements OnInit {
  private readonly api = inject(RemotePathMappingsApiService);
  private readonly clientsApi = inject(DownloadClientsApiService);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);

  readonly mappings = signal<RemotePathMapping[]>([]);
  readonly clients = signal<DownloadClientRow[]>([]);
  readonly loading = signal(true);
  readonly listError = signal('');

  // Modal state
  readonly modalOpen = signal(false);
  readonly formClientId = signal<number | undefined>(undefined);
  readonly formRemotePath = signal('');
  readonly formLocalPath = signal('');
  readonly saving = signal(false);
  readonly saveError = signal('');

  ngOnInit() {
    this.reload();
  }

  async reload() {
    this.loading.set(true);
    try {
      const [mappings, clients] = await Promise.all([
        this.api.list(),
        this.clientsApi.list(),
      ]);
      this.mappings.set(mappings);
      this.clients.set(clients);
    } catch {
      this.listError.set('Error');
    } finally {
      this.loading.set(false);
    }
  }

  openModal() {
    this.formClientId.set(undefined);
    this.formRemotePath.set('');
    this.formLocalPath.set('');
    this.saveError.set('');
    this.modalOpen.set(true);
  }

  closeModal() {
    this.modalOpen.set(false);
  }

  async save() {
    const remotePath = this.formRemotePath().trim();
    const localPath = this.formLocalPath().trim();
    if (!remotePath || !localPath) return;

    this.saving.set(true);
    this.saveError.set('');
    try {
      const created = await this.api.create({
        downloadClientId: this.formClientId(),
        remotePath,
        localPath,
      });
      this.mappings.update((list) => [...list, created]);
      this.modalOpen.set(false);
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string | string[] } };
      const msg = Array.isArray(httpErr.error?.message)
        ? httpErr.error.message.join(', ')
        : httpErr.error?.message;
      this.saveError.set(msg ?? 'Error');
    } finally {
      this.saving.set(false);
    }
  }

  async remove(mapping: RemotePathMapping) {
    if (!await this.confirmation.confirm({ title: this.translate.instant('common.confirm'), message: this.translate.instant('settings.remote_path_mappings.confirm_delete'), variant: 'danger' })) return;
    try {
      await this.api.remove(mapping.id);
      this.mappings.update((list) => list.filter((m) => m.id !== mapping.id));
    } catch {
      // ignore
    }
  }

  clientName(clientId?: number): string {
    if (!clientId) return '—';
    const client = this.clients().find((c) => c.id === clientId);
    return client?.name ?? `#${clientId}`;
  }

  onClientChange(value: string) {
    this.formClientId.set(value ? Number(value) : undefined);
  }
}
