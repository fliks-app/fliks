import {
  Component,
  ChangeDetectionStrategy,
  signal,
  computed,
  inject,
  OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import { LibrariesApiService, Library } from '../../core/services/api/libraries-api.service';

interface ImportApiResult {
  imported: number;
  errors: string[];
  rootFoldersCreated: string[];
  qualityProfilesCreated: string[];
  subtitlesImported?: number;
}

/**
 * "new" sentinel for the library select → tells the import to create a new
 * library (optionally with `newLibraryName`). null/undefined means "auto-create
 * with a timestamped default name" on the backend.
 */
type LibrarySelection = number | 'new' | null;

@Component({
  selector: 'app-import',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './import.html',
})
export class ImportComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly translate = inject(TranslateService);
  private readonly librariesApi = inject(LibrariesApiService);

  readonly libraries = signal<Library[]>([]);
  readonly movieLibraries = computed(() =>
    this.libraries().filter((l) => l.mediaTypes.includes('movie')),
  );
  readonly seriesLibraries = computed(() =>
    this.libraries().filter((l) => l.mediaTypes.includes('series')),
  );

  // Radarr form
  readonly radarrUrl = signal('');
  readonly radarrApiKey = signal('');
  readonly radarrMode = signal<'skip' | 'update'>('skip');
  readonly radarrImportSubs = signal(false);
  readonly radarrLibrary = signal<LibrarySelection>(null);
  readonly radarrNewLibraryName = signal('');
  readonly radarrLoading = signal(false);
  readonly radarrResult = signal<ImportApiResult | null>(null);
  readonly radarrError = signal('');

  // Sonarr form
  readonly sonarrUrl = signal('');
  readonly sonarrApiKey = signal('');
  readonly sonarrMode = signal<'skip' | 'update'>('skip');
  readonly sonarrImportSubs = signal(false);
  readonly sonarrLibrary = signal<LibrarySelection>(null);
  readonly sonarrNewLibraryName = signal('');
  readonly sonarrLoading = signal(false);
  readonly sonarrResult = signal<ImportApiResult | null>(null);
  readonly sonarrError = signal('');

  async ngOnInit() {
    try {
      this.libraries.set(await this.librariesApi.list());
    } catch {
      /* empty selects fall back to auto-create */
    }
  }

  private libraryBody(sel: LibrarySelection, newName: string) {
    if (typeof sel === 'number') return { targetLibraryId: sel };
    if (sel === 'new') return { newLibraryName: newName.trim() || undefined };
    return {};
  }

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
          url,
          apiKey,
          mode: this.radarrMode(),
          importSubtitles: this.radarrImportSubs(),
          ...this.libraryBody(this.radarrLibrary(), this.radarrNewLibraryName()),
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
          url,
          apiKey,
          mode: this.sonarrMode(),
          importSubtitles: this.sonarrImportSubs(),
          ...this.libraryBody(this.sonarrLibrary(), this.sonarrNewLibraryName()),
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
