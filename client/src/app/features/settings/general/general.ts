import {
  Component,
  signal,
  inject,
  OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TvSelectDirective } from '../../../shared/directives/tv-select.directive';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { DEFAULT_LOCALE } from '../../../core/constants/app-locale';
import { SettingsApiService } from '../../../core/services/api/settings-api.service';
import { ToastService } from '../../../core/services/toast.service';
import { SetupChecklistComponent } from '../../../shared/components/setup-checklist/setup-checklist';
import {
  METADATA_LANGUAGE_OPTIONS,
  metadataRegionOptions,
} from '../../../core/constants/metadata-locale';

@Component({
  selector: 'app-general-settings',
  imports: [TvSelectDirective, FormsModule, TranslatePipe, SetupChecklistComponent],
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

  // Metadata language + region
  readonly metadataLanguage = signal('en');
  readonly metadataRegion = signal('US');
  readonly savingMetadataLanguage = signal(false);
  readonly metadataLanguageOptions = METADATA_LANGUAGE_OPTIONS;
  readonly metadataRegionOptions = metadataRegionOptions(this.translate.currentLang() ?? DEFAULT_LOCALE);

  // Automation
  readonly autoDetectMarkersOnImport = signal('true');
  readonly autoGenerateSpritesOnImport = signal('true');
  readonly companionFileExtensions = signal('');
  readonly savingAutomation = signal(false);

  async ngOnInit() {
    try {
      const map = await this.api.getAll();
      this.serverName.set(map['server_name'] ?? '');
      this.publicUrl.set(map['public_url'] ?? '');
      this.metadataLanguage.set(map['metadata_language'] ?? 'en');
      this.metadataRegion.set(map['metadata_region'] ?? 'US');
      this.autoDetectMarkersOnImport.set(map['markers_auto_detect_on_import'] ?? 'true');
      this.autoGenerateSpritesOnImport.set(map['sprites_auto_generate_on_import'] ?? 'true');
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

  async saveMetadataLanguage() {
    this.savingMetadataLanguage.set(true);
    try {
      await this.api.setBulk({
        metadata_language: this.metadataLanguage(),
        metadata_region: this.metadataRegion(),
      });
      this.toast.success(this.translate.instant('settings.general.saved'));
    } catch { /* interceptor */ } finally { this.savingMetadataLanguage.set(false); }
  }

  async saveAutomation() {
    this.savingAutomation.set(true);
    try {
      await this.api.setBulk({
        markers_auto_detect_on_import: this.autoDetectMarkersOnImport(),
        sprites_auto_generate_on_import: this.autoGenerateSpritesOnImport(),
        companion_file_extensions: this.companionFileExtensions(),
      });
      this.toast.success(this.translate.instant('settings.general.saved'));
    } catch { /* interceptor */ } finally { this.savingAutomation.set(false); }
  }
}
