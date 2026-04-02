import {
  Component,
  ChangeDetectionStrategy,
  signal,
  inject,
  OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { SettingsApiService } from '../../../core/services/api/settings-api.service';

@Component({
  selector: 'app-general-settings',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './general.html',
})
export class GeneralSettingsComponent implements OnInit {
  private readonly api = inject(SettingsApiService);
  private readonly translate = inject(TranslateService);

  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly error = signal('');
  readonly saved = signal(false);

  readonly tmdbApiKey = signal('');
  readonly searchMissingAuto = signal('true');
  readonly rssSyncInterval = signal('15');
  readonly postImportScript = signal('');
  readonly companionFileExtensions = signal('');
  readonly stalledDeleteEnabled = signal('false');
  readonly stalledDeleteAfterMinutes = signal('60');
  readonly stalledSearchAfterDelete = signal('true');

  async ngOnInit() {
    try {
      const map = await this.api.getAll();
      this.tmdbApiKey.set(map['tmdb_api_key'] ?? '');
      this.searchMissingAuto.set(map['search_missing_auto'] ?? 'true');
      this.rssSyncInterval.set(map['rss_sync_interval'] ?? '15');
      this.postImportScript.set(map['post_import_script'] ?? '');
      this.companionFileExtensions.set(
        map['companion_file_extensions'] ??
        '.nfo,.srt,.ass,.ssa,.sub,.idx,.vtt,.sup,.txt,.jpg,.jpeg,.png,.tbn,.nfo-orig',
      );
      this.stalledDeleteEnabled.set(map['stalled_delete_enabled'] ?? 'false');
      this.stalledDeleteAfterMinutes.set(map['stalled_delete_after_minutes'] ?? '60');
      this.stalledSearchAfterDelete.set(map['stalled_search_after_delete'] ?? 'true');
    } catch {
      this.error.set(this.translate.instant('settings.general.load_error'));
    } finally {
      this.loading.set(false);
    }
  }

  async save() {
    this.saving.set(true);
    this.error.set('');
    this.saved.set(false);
    try {
      await this.api.setBulk({
        tmdb_api_key: this.tmdbApiKey(),
        search_missing_auto: this.searchMissingAuto(),
        rss_sync_interval: this.rssSyncInterval(),
        post_import_script: this.postImportScript(),
        companion_file_extensions: this.companionFileExtensions(),
        stalled_delete_enabled: this.stalledDeleteEnabled(),
        stalled_delete_after_minutes: this.stalledDeleteAfterMinutes(),
        stalled_search_after_delete: this.stalledSearchAfterDelete(),
      });
      this.saved.set(true);
      setTimeout(() => this.saved.set(false), 3000);
    } catch {
      this.error.set(this.translate.instant('settings.general.save_error'));
    } finally {
      this.saving.set(false);
    }
  }
}
