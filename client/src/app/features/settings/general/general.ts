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
import { ToastService } from '../../../core/services/toast.service';

@Component({
  selector: 'app-general-settings',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './general.html',
})
export class GeneralSettingsComponent implements OnInit {
  private readonly api = inject(SettingsApiService);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);

  readonly loading = signal(true);
  readonly error = signal('');

  // Server
  readonly serverName = signal('');
  readonly publicUrl = signal('');
  readonly savingServer = signal(false);

  // Providers
  readonly tmdbApiKey = signal('');
  readonly tvdbApiKey = signal('');
  readonly tvdbPin = signal('');
  readonly savingProviders = signal(false);

  // Automation
  readonly searchMissingAuto = signal('true');
  readonly rssSyncInterval = signal('15');
  readonly companionFileExtensions = signal('');
  readonly savingAutomation = signal(false);

  // Post-import
  readonly postImportScript = signal('');
  readonly savingPostImport = signal(false);

  async ngOnInit() {
    try {
      const map = await this.api.getAll();
      this.serverName.set(map['server_name'] ?? '');
      this.publicUrl.set(map['public_url'] ?? '');
      this.tmdbApiKey.set(map['tmdb_api_key'] ?? '');
      this.tvdbApiKey.set(map['tvdb_api_key'] ?? '');
      this.tvdbPin.set(map['tvdb_pin'] ?? '');
      this.searchMissingAuto.set(map['search_missing_auto'] ?? 'true');
      this.rssSyncInterval.set(map['rss_sync_interval'] ?? '15');
      this.postImportScript.set(map['post_import_script'] ?? '');
      this.companionFileExtensions.set(
        map['companion_file_extensions'] ??
        '.nfo,.srt,.ass,.ssa,.sub,.idx,.vtt,.sup,.txt,.jpg,.jpeg,.png,.tbn,.nfo-orig',
      );
    } catch {
      this.error.set(this.translate.instant('settings.general.load_error'));
    } finally {
      this.loading.set(false);
    }
  }

  async saveServer() {
    this.savingServer.set(true);
    try {
      await this.api.setBulk({
        server_name: this.serverName(),
        public_url: this.publicUrl(),
      });
      this.toast.success(this.translate.instant('settings.general.saved'));
    } catch { /* interceptor */ } finally { this.savingServer.set(false); }
  }

  async saveProviders() {
    this.savingProviders.set(true);
    try {
      await this.api.setBulk({
        tmdb_api_key: this.tmdbApiKey(),
        tvdb_api_key: this.tvdbApiKey(),
        tvdb_pin: this.tvdbPin() || null,
      });
      this.toast.success(this.translate.instant('settings.general.saved'));
    } catch { /* interceptor */ } finally { this.savingProviders.set(false); }
  }

  async saveAutomation() {
    this.savingAutomation.set(true);
    try {
      await this.api.setBulk({
        search_missing_auto: this.searchMissingAuto(),
        rss_sync_interval: this.rssSyncInterval(),
        companion_file_extensions: this.companionFileExtensions(),
      });
      this.toast.success(this.translate.instant('settings.general.saved'));
    } catch { /* interceptor */ } finally { this.savingAutomation.set(false); }
  }

  async savePostImport() {
    this.savingPostImport.set(true);
    try {
      await this.api.setBulk({ post_import_script: this.postImportScript() });
      this.toast.success(this.translate.instant('settings.general.saved'));
    } catch { /* interceptor */ } finally { this.savingPostImport.set(false); }
  }
}
