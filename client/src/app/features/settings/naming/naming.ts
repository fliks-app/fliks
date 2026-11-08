import {
  Component,
  signal,
  WritableSignal,
  inject,
  computed,
  OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
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
    .replace(/\{Original Title\}/g, 'Breaking Bad')
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

function applyBookFormat(format: string): string {
  return format
    .replace(/\{Author\}/g, 'A. Writer')
    .replace(/\{SeriesPosition\}/g, '3')
    .replace(/\{Series\}/g, 'Orbit Cycle')
    .replace(/\{Title\}/g, 'Nova Skyline')
    .replace(/\{Year\}/g, '2021')
    .replace(/\{Narrator\}/g, 'N. Voice')
    .replace(/\{Language\}/g, 'fr')
    .replace(/\{Format\}/g, 'epub')
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function applyAlbumFormat(format: string): string {
  return format
    .replace(/\{Artist SortName\}/g, 'Vell, Cora')
    .replace(/\{Artist Name\}/g, 'Cora Vell')
    .replace(/\{Album Title\}/g, 'Salt Meadows')
    .replace(/\{Release Year\}/g, '2019')
    .replace(/\{Album Type\}/g, 'Album')
    .replace(/\{Medium Format\}/g, 'CD')
    .replace(/\{medium:00\}/g, '02')
    .replace(/\{medium\}/g, '2')
    .replace(/\{track:00\}/g, '05')
    .replace(/\{track\}/g, '5')
    .replace(/\{Track Title\}/g, 'Low Tide')
    .replace(/\{Track Artist\}/g, 'Cora Vell')
    .replace(/\{Quality Full\}/g, 'FLAC')
    .replace(/\{Release Group\}/g, 'GRP')
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

type AlbumField = 'artistFolder' | 'albumFolder' | 'track' | 'multiDiscTrack';

@Component({
  selector: 'app-naming-settings',
  imports: [FormsModule, TranslatePipe],
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

  readonly bookFormat = signal('{Title} ({Year})');
  readonly bookFolderFormat = signal('{Title}');

  readonly albumFormats: Record<AlbumField, WritableSignal<string>> = {
    artistFolder: signal('{Artist Name}'),
    albumFolder: signal('{Album Title} ({Release Year})'),
    track: signal('{track:00} - {Track Title}'),
    multiDiscTrack: signal('{medium:00}-{track:00} - {Track Title}'),
  };
  readonly albumFields: { field: AlbumField; labelKey: string }[] = [
    { field: 'artistFolder', labelKey: 'settings.naming.artist_folder_format' },
    { field: 'albumFolder', labelKey: 'settings.naming.album_folder_format' },
    { field: 'track', labelKey: 'settings.naming.track_format' },
    { field: 'multiDiscTrack', labelKey: 'settings.naming.multi_disc_track_format' },
  ];
  readonly albumTokens = [
    '{Artist Name}', '{Artist SortName}', '{Album Title}', '{Release Year}', '{Album Type}',
    '{Medium Format}', '{medium:00}', '{medium}', '{track:00}', '{track}', '{Track Title}',
    '{Track Artist}', '{Quality Full}', '{Release Group}',
  ];
  readonly albumPreview = computed(() => {
    const f = this.albumFormats;
    return {
      artistFolder: applyAlbumFormat(f.artistFolder()),
      albumFolder: applyAlbumFormat(f.albumFolder()),
      track: applyAlbumFormat(f.track()),
      multiDiscTrack: applyAlbumFormat(f.multiDiscTrack()),
    };
  });

  readonly moviePreview = computed(() => applyMovieFormat(this.movieFormat()));
  readonly seriesFolderPreview = computed(() => applySeriesFolderFormat(this.seriesFolderFormat()));
  readonly seasonFolderPreview = computed(() => applySeasonFolderFormat(this.seasonFolderFormat()));
  readonly seriesPreview = computed(() => applySeriesFormat(this.seriesFormat()));
  readonly bookPreview = computed(() => applyBookFormat(this.bookFormat()));
  readonly bookFolderPreview = computed(() => applyBookFormat(this.bookFolderFormat()));
  readonly seriesFullPreview = computed(() => {
    const folder = this.seriesFolderPreview();
    const season = this.seasonFolderPreview();
    const file = this.seriesPreview();
    return `${folder}/${season}/${file}`;
  });

  readonly bookTokens = [
    '{Author}', '{Series}', '{SeriesPosition}', '{Title}', '{Year}',
    '{Narrator}', '{Language}', '{Format}',
  ];

  readonly movieTokens = [
    '{Movie Title}', '{Release Year}', '{Quality Full}', '{Quality Title}',
    '{MediaInfo AudioCodec}', '{MediaInfo VideoCodec}', '{Release Group}',
    '{Original Title}', '{TMDB Id}',
  ];

  readonly seriesFolderTokens = [
    '{Series Title}', '{Original Title}', '{Release Year}', '{TMDB Id}',
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
      if (map['naming_book_format']) this.bookFormat.set(map['naming_book_format']);
      if (map['naming_book_folder_format']) this.bookFolderFormat.set(map['naming_book_folder_format']);
      const albumKeys: Record<AlbumField, string> = {
        artistFolder: 'naming_artist_folder_format',
        albumFolder: 'naming_album_folder_format',
        track: 'naming_track_format',
        multiDiscTrack: 'naming_multi_disc_track_format',
      };
      for (const [field, key] of Object.entries(albumKeys)) {
        if (map[key]) this.albumFormats[field as AlbumField].set(map[key]);
      }
    } catch {
      this.error.set(this.translate.instant('settings.naming.load_error'));
    } finally {
      this.loading.set(false);
    }
  }

  insertToken(field: 'movie' | 'series' | 'seriesFolder' | 'seasonFolder' | 'book' | 'bookFolder', token: string) {
    switch (field) {
      case 'movie': this.movieFormat.update((f) => f + token); break;
      case 'seriesFolder': this.seriesFolderFormat.update((f) => f + token); break;
      case 'seasonFolder': this.seasonFolderFormat.update((f) => f + token); break;
      case 'series': this.seriesFormat.update((f) => f + token); break;
      case 'book': this.bookFormat.update((f) => f + token); break;
      case 'bookFolder': this.bookFolderFormat.update((f) => f + token); break;
    }
  }

  insertAlbumToken(field: AlbumField, token: string) {
    this.albumFormats[field].update((f) => f + token);
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
        naming_book_format: this.bookFormat(),
        naming_book_folder_format: this.bookFolderFormat(),
        naming_artist_folder_format: this.albumFormats.artistFolder(),
        naming_album_folder_format: this.albumFormats.albumFolder(),
        naming_track_format: this.albumFormats.track(),
        naming_multi_disc_track_format: this.albumFormats.multiDiscTrack(),
      });
      this.toast.success(this.translate.instant('settings.naming.saved'));
    } catch {
      // handled by global error interceptor
    } finally {
      this.saving.set(false);
    }
  }
}
