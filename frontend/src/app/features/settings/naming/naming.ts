import {
  Component,
  ChangeDetectionStrategy,
  signal,
  inject,
  computed,
  OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { SettingsApiService } from '../../../core/services/api/settings-api.service';
import { ToastService } from '../../../core/services/toast.service';

function applyMovieFormat(format: string): string {
  return format
    .replace(/\{Movie Title\}/g, 'Inception')
    .replace(/\{Original Title\}/g, 'Inception')
    .replace(/\{Release Year\}/g, '2010')
    .replace(/\{Quality Full\}/g, '1080p Bluray x264')
    .replace(/\{Quality Title\}/g, '1080p')
    .replace(/\{Release Group\}/g, 'FGT')
    .replace(/\{TMDB Id\}/g, '27205')
    .replace(/\{MediaInfo AudioCodec\}/g, 'DTS')
    .replace(/\{MediaInfo VideoCodec\}/g, 'x264')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function applySeriesFormat(format: string): string {
  return format
    .replace(/\{Series Title\}/g, 'Breaking Bad')
    .replace(/\{season:00\}/g, '03')
    .replace(/\{episode:00\}/g, '07')
    .replace(/\{Episode Title\}/g, 'One Minute')
    .replace(/\{Quality Full\}/g, '1080p WEB-DL x264')
    .replace(/\{Quality Title\}/g, '1080p')
    .replace(/\{Release Group\}/g, 'NTG')
    .replace(/\{Air Date\}/g, '2010-05-02')
    .replace(/\{MediaInfo AudioCodec\}/g, 'AAC')
    .replace(/\{MediaInfo VideoCodec\}/g, 'x264')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function applySeriesFolderFormat(format: string): string {
  return format
    .replace(/\{Series Title\}/g, 'Breaking Bad')
    .replace(/\{Release Year\}/g, '2008')
    .replace(/\{TMDB Id\}/g, '1396')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function applySeasonFolderFormat(format: string): string {
  return format
    .replace(/\{season:00\}/g, '03')
    .replace(/\{season\}/g, '3')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

@Component({
  selector: 'app-naming-settings',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './naming.html',
})
export class NamingSettingsComponent implements OnInit {
  private readonly api = inject(SettingsApiService);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);

  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly error = signal('');

  readonly movieFormat = signal('{Movie Title} ({Release Year}) {Quality Full}');
  readonly seriesFolderFormat = signal('{Series Title}');
  readonly seasonFolderFormat = signal('Season {season:00}');
  readonly seriesFormat = signal('{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}');

  readonly moviePreview = computed(() => applyMovieFormat(this.movieFormat()));
  readonly seriesFolderPreview = computed(() => applySeriesFolderFormat(this.seriesFolderFormat()));
  readonly seasonFolderPreview = computed(() => applySeasonFolderFormat(this.seasonFolderFormat()));
  readonly seriesPreview = computed(() => applySeriesFormat(this.seriesFormat()));
  readonly seriesFullPreview = computed(() => {
    const folder = this.seriesFolderPreview();
    const season = this.seasonFolderPreview();
    const file = this.seriesPreview();
    return `${folder}/${season}/${file}`;
  });

  readonly movieTokens = [
    '{Movie Title}', '{Release Year}', '{Quality Full}', '{Quality Title}',
    '{MediaInfo AudioCodec}', '{MediaInfo VideoCodec}', '{Release Group}',
    '{Original Title}', '{TMDB Id}',
  ];

  readonly seriesFolderTokens = [
    '{Series Title}', '{Release Year}', '{TMDB Id}',
  ];

  readonly seasonFolderTokens = [
    '{season:00}', '{season}',
  ];

  readonly seriesTokens = [
    '{Series Title}', '{season:00}', '{episode:00}', '{Episode Title}',
    '{Quality Full}', '{Quality Title}', '{MediaInfo AudioCodec}',
    '{MediaInfo VideoCodec}', '{Release Group}', '{Air Date}',
  ];

  async ngOnInit() {
    try {
      const map = await this.api.getAll();
      if (map['naming_movie_format']) this.movieFormat.set(map['naming_movie_format']);
      if (map['naming_series_folder_format']) this.seriesFolderFormat.set(map['naming_series_folder_format']);
      if (map['naming_season_folder_format']) this.seasonFolderFormat.set(map['naming_season_folder_format']);
      if (map['naming_series_format']) this.seriesFormat.set(map['naming_series_format']);
    } catch {
      this.error.set(this.translate.instant('settings.naming.load_error'));
    } finally {
      this.loading.set(false);
    }
  }

  insertToken(field: 'movie' | 'series' | 'seriesFolder' | 'seasonFolder', token: string) {
    switch (field) {
      case 'movie': this.movieFormat.update((f) => f + token); break;
      case 'seriesFolder': this.seriesFolderFormat.update((f) => f + token); break;
      case 'seasonFolder': this.seasonFolderFormat.update((f) => f + token); break;
      case 'series': this.seriesFormat.update((f) => f + token); break;
    }
  }

  async save() {
    this.saving.set(true);
    this.error.set('');
    try {
      await this.api.setBulk({
        naming_movie_format: this.movieFormat(),
        naming_series_folder_format: this.seriesFolderFormat(),
        naming_season_folder_format: this.seasonFolderFormat(),
        naming_series_format: this.seriesFormat(),
      });
      this.toast.success(this.translate.instant('settings.naming.saved'));
    } catch {
      // handled by global error interceptor
    } finally {
      this.saving.set(false);
    }
  }
}
