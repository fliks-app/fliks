import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { TranslateService } from '@ngx-translate/core';
import { ProviderListComponent } from '../../../shared/components/provider-list/provider-list';
import {
  ProviderDraft,
  ProviderImplementation,
  ProviderListLabels,
  ProviderTestResult,
} from '../../../shared/components/provider-list/provider-list.types';

const IMPLEMENTATIONS: ProviderImplementation[] = [
  {
    implementation: 'qbittorrent',
    labelKey: 'settings.download_clients.type_qbittorrent',
    fields: [
      { key: 'host', type: 'text', labelKey: 'settings.download_clients.field_host', default: 'localhost' },
      { key: 'port', type: 'number', labelKey: 'settings.download_clients.field_port', default: 8080 },
      { key: 'username', type: 'text', labelKey: 'settings.download_clients.field_username' },
      { key: 'password', type: 'password', labelKey: 'settings.download_clients.field_password', secret: true },
      { key: 'useSsl', type: 'toggle', labelKey: 'settings.download_clients.field_ssl' },
      { key: 'category', type: 'text', labelKey: 'settings.download_clients.field_category', default: 'fliks' },
      { key: 'movieCategory', type: 'text', labelKey: 'settings.download_clients.field_movie_category' },
      { key: 'seriesCategory', type: 'text', labelKey: 'settings.download_clients.field_series_category' },
    ],
  },
];

const LABELS: ProviderListLabels = {
  newLabelKey: 'settings.download_clients.new',
  colNameKey: 'settings.download_clients.col_name',
  colImplementationKey: 'settings.download_clients.col_type',
  colPriorityKey: 'settings.download_clients.col_priority',
  colEnabledKey: 'settings.download_clients.col_enabled',
  actionsKey: 'settings.download_clients.actions',
  editKey: 'settings.download_clients.edit',
  deleteKey: 'settings.download_clients.delete',
  saveKey: 'settings.download_clients.save',
  cancelKey: 'settings.download_clients.cancel',
  createTitleKey: 'settings.download_clients.editor_create',
  editTitleKey: 'settings.download_clients.editor_edit',
  fieldNameKey: 'settings.download_clients.field_name',
  fieldImplementationKey: 'settings.download_clients.field_type',
  fieldPriorityKey: 'settings.download_clients.field_priority',
  fieldEnabledKey: 'settings.download_clients.field_enabled',
  emptyKey: 'settings.download_clients.empty',
  loadErrorKey: 'settings.download_clients.load_error',
  confirmDeleteKey: 'settings.download_clients.confirm_delete',
  deleteErrorKey: 'settings.download_clients.delete_error',
  testConnectionKey: 'settings.download_clients.test_connection',
};

@Component({
  selector: 'app-download-clients-settings',
  imports: [ProviderListComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './download-clients.html',
})
export class DownloadClientsSettingsComponent {
  private readonly http = inject(HttpClient);
  private readonly translate = inject(TranslateService);

  readonly listUrl = '/api/download-clients';
  readonly implementations = IMPLEMENTATIONS;
  readonly labels = LABELS;
  readonly defaultPriority = 1;

  readonly testConnection = async (draft: ProviderDraft): Promise<ProviderTestResult> => {
    try {
      return await firstValueFrom(
        this.http.post<ProviderTestResult>('/api/download-clients/test-connection', {
          implementation: draft.implementation,
          settings: draft.settings,
        }),
      );
    } catch {
      return { ok: false, message: this.translate.instant('settings.download_clients.test_error') };
    }
  };
}
