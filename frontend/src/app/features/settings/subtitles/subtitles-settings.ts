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
  selector: 'app-subtitles-settings',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './subtitles-settings.html',
})
export class SubtitlesSettingsComponent implements OnInit {
  private readonly api = inject(SettingsApiService);
  private readonly translate = inject(TranslateService);

  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly error = signal('');
  readonly saved = signal(false);

  readonly autoSearch = signal('true');
  readonly searchInterval = signal('360');
  readonly upgradeInterval = signal('720');
  readonly minScore = signal('70');
  readonly upgradeThreshold = signal('90');
  readonly autoSync = signal('false');
  readonly encodeUtf8 = signal('true');

  async ngOnInit() {
    try {
      const map = await this.api.getAll();
      this.autoSearch.set(map['subtitle_auto_search'] ?? 'true');
      this.searchInterval.set(map['subtitle_search_interval'] ?? '360');
      this.upgradeInterval.set(map['subtitle_upgrade_interval'] ?? '720');
      this.minScore.set(map['subtitle_min_score'] ?? '70');
      this.upgradeThreshold.set(map['subtitle_upgrade_threshold'] ?? '90');
      this.autoSync.set(map['subtitle_auto_sync'] ?? 'false');
      this.encodeUtf8.set(map['subtitle_encode_utf8'] ?? 'true');
    } catch {
      this.error.set(this.translate.instant('settings.subtitles.load_error'));
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
        subtitle_auto_search: this.autoSearch(),
        subtitle_search_interval: this.searchInterval(),
        subtitle_upgrade_interval: this.upgradeInterval(),
        subtitle_min_score: this.minScore(),
        subtitle_upgrade_threshold: this.upgradeThreshold(),
        subtitle_auto_sync: this.autoSync(),
        subtitle_encode_utf8: this.encodeUtf8(),
      });
      this.saved.set(true);
      setTimeout(() => this.saved.set(false), 3000);
    } catch {
      this.error.set(this.translate.instant('settings.subtitles.save_error'));
    } finally {
      this.saving.set(false);
    }
  }
}
