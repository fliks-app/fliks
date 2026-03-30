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

  async ngOnInit() {
    try {
      const map = await this.api.getAll();
      this.tmdbApiKey.set(map['tmdb_api_key'] ?? '');
      this.searchMissingAuto.set(map['search_missing_auto'] ?? 'true');
      this.rssSyncInterval.set(map['rss_sync_interval'] ?? '15');
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
