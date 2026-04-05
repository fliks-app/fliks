import {
  Component,
  ChangeDetectionStrategy,
  signal,
  inject,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';

interface ImportApiResult {
  imported: number;
  errors: string[];
  rootFoldersCreated: string[];
  qualityProfilesCreated: string[];
  subtitlesImported?: number;
}

@Component({
  selector: 'app-import',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './import.html',
})
export class ImportComponent {
  private readonly http = inject(HttpClient);
  private readonly translate = inject(TranslateService);

  // Radarr form
  readonly radarrUrl = signal('');
  readonly radarrApiKey = signal('');
  readonly radarrMode = signal<'skip' | 'update'>('skip');
  readonly radarrImportSubs = signal(false);
  readonly radarrLoading = signal(false);
  readonly radarrResult = signal<ImportApiResult | null>(null);
  readonly radarrError = signal('');

  // Sonarr form
  readonly sonarrUrl = signal('');
  readonly sonarrApiKey = signal('');
  readonly sonarrMode = signal<'skip' | 'update'>('skip');
  readonly sonarrImportSubs = signal(false);
  readonly sonarrLoading = signal(false);
  readonly sonarrResult = signal<ImportApiResult | null>(null);
  readonly sonarrError = signal('');

  async importRadarr() {
    const url = this.radarrUrl().trim();
    const apiKey = this.radarrApiKey().trim();
    if (!url || !apiKey) return;

    this.radarrLoading.set(true);
    this.radarrResult.set(null);
    this.radarrError.set('');
    try {
      const result = await firstValueFrom(
        this.http.post<ImportApiResult>('/api/system/import-radarr-api', {
          url, apiKey, mode: this.radarrMode(), importSubtitles: this.radarrImportSubs(),
        }),
      );
      this.radarrResult.set(result);
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      this.radarrError.set(httpErr.error?.message ?? this.translate.instant('import.error'));
    } finally {
      this.radarrLoading.set(false);
    }
  }

  async importSonarr() {
    const url = this.sonarrUrl().trim();
    const apiKey = this.sonarrApiKey().trim();
    if (!url || !apiKey) return;

    this.sonarrLoading.set(true);
    this.sonarrResult.set(null);
    this.sonarrError.set('');
    try {
      const result = await firstValueFrom(
        this.http.post<ImportApiResult>('/api/system/import-sonarr-api', {
          url, apiKey, mode: this.sonarrMode(), importSubtitles: this.sonarrImportSubs(),
        }),
      );
      this.sonarrResult.set(result);
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      this.sonarrError.set(httpErr.error?.message ?? this.translate.instant('import.error'));
    } finally {
      this.sonarrLoading.set(false);
    }
  }
}
