import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { LucideDownload } from '@lucide/angular';
import { firstValueFrom } from 'rxjs';
import { ImportDiskComponent } from '../../import-disk/import-disk';
import { SeerrApiService } from '../../../core/services/api/seerr-api.service';
import { SettingsApiService } from '../../../core/services/api/settings-api.service';
import {
  LibrariesApiService,
  Library,
} from '../../../core/services/api/libraries-api.service';
import {
  MediaServersApiService,
  MediaServerRow,
} from '../../../core/services/api/media-servers-api.service';
import { SseService } from '../../../core/services/sse.service';
import { ToastService } from '../../../core/services/toast.service';

const SETTING_SEERR_URL = 'seerr_url';
const SETTING_SEERR_API_KEY = 'seerr_api_key';
const SETTING_RADARR_URL = 'radarr_url';
const SETTING_RADARR_API_KEY = 'radarr_api_key';
const SETTING_SONARR_URL = 'sonarr_url';
const SETTING_SONARR_API_KEY = 'sonarr_api_key';

interface SeerrSummary {
  users: number;
  usersCreated: number;
  imported: number;
  updated: number;
  skipped: number;
}

interface ArrImportResult {
  imported: number;
  errors: string[];
  rootFoldersCreated: string[];
  qualityProfilesCreated: string[];
  subtitlesImported?: number;
}

/**
 * "new" sentinel for the library select -> tells the import to create a new
 * library (optionally with `newLibraryName`). null/undefined means "auto-create
 * with a timestamped default name" on the backend.
 */
type LibrarySelection = number | 'new' | null;

@Component({
  selector: 'app-data-imports-settings',
  imports: [FormsModule, TranslateModule, LucideDownload, ImportDiskComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './data-imports.html',
})
export class DataImportsSettingsComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly settingsApi = inject(SettingsApiService);
  private readonly seerrApi = inject(SeerrApiService);
  private readonly librariesApi = inject(LibrariesApiService);
  private readonly mediaServersApi = inject(MediaServersApiService);
  private readonly sse = inject(SseService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  readonly loading = signal(true);

  // ---- Emby (watch history) ----
  readonly embyServers = signal<MediaServerRow[]>([]);
  /** Server IDs whose watch-history import is currently running. */
  readonly embyImportingIds = signal<Set<number>>(new Set());

  // ---- Seerr ----
  readonly seerrSaving = signal(false);
  readonly seerrTesting = signal(false);
  readonly seerrImporting = signal(false);
  readonly seerrUrl = signal('');
  readonly seerrApiKey = signal('');
  readonly seerrTestResult = signal<{
    ok: boolean;
    message: string;
  } | null>(null);
  readonly seerrLastSummary = signal<SeerrSummary | null>(null);

  // ---- Radarr / Sonarr ----
  readonly libraries = signal<Library[]>([]);
  readonly movieLibraries = computed(() =>
    this.libraries().filter((l) => l.mediaTypes.includes('movie')),
  );
  readonly seriesLibraries = computed(() =>
    this.libraries().filter((l) => l.mediaTypes.includes('series')),
  );

  readonly radarrUrl = signal('');
  readonly radarrApiKey = signal('');
  readonly radarrMode = signal<'skip' | 'update'>('skip');
  readonly radarrImportSubs = signal(false);
  readonly radarrLibrary = signal<LibrarySelection>(null);
  readonly radarrNewLibraryName = signal('');
  readonly radarrLoading = signal(false);
  readonly radarrSaving = signal(false);
  readonly radarrTesting = signal(false);
  readonly radarrTestResult = signal<{
    ok: boolean;
    message: string;
  } | null>(null);
  readonly radarrResult = signal<ArrImportResult | null>(null);
  readonly radarrError = signal('');

  readonly sonarrUrl = signal('');
  readonly sonarrApiKey = signal('');
  readonly sonarrMode = signal<'skip' | 'update'>('skip');
  readonly sonarrImportSubs = signal(false);
  readonly sonarrLibrary = signal<LibrarySelection>(null);
  readonly sonarrNewLibraryName = signal('');
  readonly sonarrLoading = signal(false);
  readonly sonarrSaving = signal(false);
  readonly sonarrTesting = signal(false);
  readonly sonarrTestResult = signal<{
    ok: boolean;
    message: string;
  } | null>(null);
  readonly sonarrResult = signal<ArrImportResult | null>(null);
  readonly sonarrError = signal('');

  private lastHandledEvent: unknown = null;

  // Listen for Seerr + Emby watch-history import SSE events. Toasts on
  // completion / failure and updates `importing` flags so buttons re-enable.
  private readonly importEffect = effect(() => {
    const event = this.sse.lastEvent();
    if (!event || event === this.lastHandledEvent) return;
    this.lastHandledEvent = event;
    if (event.type === 'watch-history.import.completed') {
      this.setEmbyImporting(Number(event['serverId']), false);
      this.toast.success(
        this.translate.instant(
          'settings.data_imports.emby.import_completed',
          {
            users: Number(event['users'] ?? 0),
            usersCreated: Number(event['usersCreated'] ?? 0),
            imported: Number(event['imported'] ?? 0),
            skipped: Number(event['skipped'] ?? 0),
          },
        ),
      );
      return;
    }
    if (event.type === 'watch-history.import.failed') {
      this.setEmbyImporting(Number(event['serverId']), false);
      const err =
        (event['error'] as string | undefined) ??
        this.translate.instant('common.error');
      this.toast.error(
        this.translate.instant(
          'settings.data_imports.emby.import_failed',
          { error: err },
        ),
      );
      return;
    }
    if (event.type === 'seerr.import.completed') {
      this.seerrImporting.set(false);
      const summary: SeerrSummary = {
        users: Number(event['users'] ?? 0),
        usersCreated: Number(event['usersCreated'] ?? 0),
        imported: Number(event['imported'] ?? 0),
        updated: Number(event['updated'] ?? 0),
        skipped: Number(event['skipped'] ?? 0),
      };
      this.seerrLastSummary.set(summary);
      this.toast.success(
        this.translate.instant(
          'settings.data_imports.seerr.import_completed',
          summary,
        ),
      );
    } else if (event.type === 'seerr.import.failed') {
      this.seerrImporting.set(false);
      const err =
        (event['error'] as string | undefined) ??
        this.translate.instant('common.error');
      this.toast.error(
        this.translate.instant(
          'settings.data_imports.seerr.import_failed',
          { error: err },
        ),
      );
    }
  });

  async ngOnInit() {
    this.loading.set(true);
    try {
      const [all, libs, servers] = await Promise.all([
        this.settingsApi.getAll(),
        this.librariesApi.list().catch(() => [] as Library[]),
        this.mediaServersApi.list().catch(() => [] as MediaServerRow[]),
      ]);
      this.seerrUrl.set(all[SETTING_SEERR_URL] ?? '');
      this.seerrApiKey.set(all[SETTING_SEERR_API_KEY] ?? '');
      this.radarrUrl.set(all[SETTING_RADARR_URL] ?? '');
      this.radarrApiKey.set(all[SETTING_RADARR_API_KEY] ?? '');
      this.sonarrUrl.set(all[SETTING_SONARR_URL] ?? '');
      this.sonarrApiKey.set(all[SETTING_SONARR_API_KEY] ?? '');
      this.libraries.set(libs);
      this.embyServers.set(servers.filter((s) => s.type === 'emby'));
    } finally {
      this.loading.set(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Emby watch history
  // ---------------------------------------------------------------------------

  private setEmbyImporting(serverId: number, running: boolean) {
    this.embyImportingIds.update((s) => {
      const next = new Set(s);
      if (running) next.add(serverId);
      else next.delete(serverId);
      return next;
    });
  }

  async importEmbyWatchHistory(server: MediaServerRow) {
    if (this.embyImportingIds().has(server.id)) return;
    this.setEmbyImporting(server.id, true);
    try {
      await this.mediaServersApi.importWatchHistory(server.id);
      this.toast.success(
        this.translate.instant(
          'settings.data_imports.emby.import_started',
          { name: server.name },
        ),
      );
    } catch (err: unknown) {
      this.setEmbyImporting(server.id, false);
      const httpErr = err as { error?: { message?: string } };
      this.toast.error(
        httpErr.error?.message ??
          this.translate.instant(
            'settings.data_imports.emby.import_failed',
            { error: '' },
          ),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Seerr
  // ---------------------------------------------------------------------------

  get canSubmitSeerr(): boolean {
    return (
      this.seerrUrl().trim().length > 0 &&
      this.seerrApiKey().trim().length > 0
    );
  }

  async saveSeerrCredentials() {
    if (this.seerrSaving()) return;
    this.seerrSaving.set(true);
    try {
      await this.settingsApi.setBulk({
        [SETTING_SEERR_URL]: this.seerrUrl()
          .trim()
          .replace(/\/$/, ''),
        [SETTING_SEERR_API_KEY]: this.seerrApiKey().trim(),
      });
      this.toast.success(this.translate.instant('common.saved'));
    } finally {
      this.seerrSaving.set(false);
    }
  }

  async testSeerr() {
    if (!this.canSubmitSeerr || this.seerrTesting()) return;
    this.seerrTesting.set(true);
    this.seerrTestResult.set(null);
    try {
      const r = await this.seerrApi.testConnection(
        this.seerrUrl().trim().replace(/\/$/, ''),
        this.seerrApiKey().trim(),
      );
      this.seerrTestResult.set(r);
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      this.seerrTestResult.set({
        ok: false,
        message:
          httpErr.error?.message ?? this.translate.instant('common.error'),
      });
    } finally {
      this.seerrTesting.set(false);
    }
  }

  async importSeerrRequests() {
    if (!this.canSubmitSeerr || this.seerrImporting()) return;
    // Persist credentials first so the backend reads the latest values.
    await this.saveSeerrCredentials();
    this.seerrImporting.set(true);
    this.seerrLastSummary.set(null);
    try {
      await this.seerrApi.importRequests();
      this.toast.success(
        this.translate.instant(
          'settings.data_imports.seerr.import_started',
        ),
      );
    } catch (err: unknown) {
      this.seerrImporting.set(false);
      const httpErr = err as { error?: { message?: string } };
      this.toast.error(
        httpErr.error?.message ??
          this.translate.instant(
            'settings.data_imports.seerr.import_failed',
            { error: '' },
          ),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Radarr / Sonarr
  // ---------------------------------------------------------------------------

  get canSubmitRadarr(): boolean {
    return (
      this.radarrUrl().trim().length > 0 &&
      this.radarrApiKey().trim().length > 0
    );
  }

  get canSubmitSonarr(): boolean {
    return (
      this.sonarrUrl().trim().length > 0 &&
      this.sonarrApiKey().trim().length > 0
    );
  }

  async saveRadarrCredentials() {
    if (this.radarrSaving()) return;
    this.radarrSaving.set(true);
    try {
      await this.settingsApi.setBulk({
        [SETTING_RADARR_URL]: this.radarrUrl().trim().replace(/\/$/, ''),
        [SETTING_RADARR_API_KEY]: this.radarrApiKey().trim(),
      });
      this.toast.success(this.translate.instant('common.saved'));
    } finally {
      this.radarrSaving.set(false);
    }
  }

  async testRadarr() {
    if (!this.canSubmitRadarr || this.radarrTesting()) return;
    this.radarrTesting.set(true);
    this.radarrTestResult.set(null);
    try {
      const r = await firstValueFrom(
        this.http.post<{ ok: boolean; message: string }>(
          '/api/imports/radarr/test',
          {
            url: this.radarrUrl().trim().replace(/\/$/, ''),
            apiKey: this.radarrApiKey().trim(),
          },
        ),
      );
      this.radarrTestResult.set(r);
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      this.radarrTestResult.set({
        ok: false,
        message:
          httpErr.error?.message ?? this.translate.instant('common.error'),
      });
    } finally {
      this.radarrTesting.set(false);
    }
  }

  async saveSonarrCredentials() {
    if (this.sonarrSaving()) return;
    this.sonarrSaving.set(true);
    try {
      await this.settingsApi.setBulk({
        [SETTING_SONARR_URL]: this.sonarrUrl().trim().replace(/\/$/, ''),
        [SETTING_SONARR_API_KEY]: this.sonarrApiKey().trim(),
      });
      this.toast.success(this.translate.instant('common.saved'));
    } finally {
      this.sonarrSaving.set(false);
    }
  }

  async testSonarr() {
    if (!this.canSubmitSonarr || this.sonarrTesting()) return;
    this.sonarrTesting.set(true);
    this.sonarrTestResult.set(null);
    try {
      const r = await firstValueFrom(
        this.http.post<{ ok: boolean; message: string }>(
          '/api/imports/sonarr/test',
          {
            url: this.sonarrUrl().trim().replace(/\/$/, ''),
            apiKey: this.sonarrApiKey().trim(),
          },
        ),
      );
      this.sonarrTestResult.set(r);
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      this.sonarrTestResult.set({
        ok: false,
        message:
          httpErr.error?.message ?? this.translate.instant('common.error'),
      });
    } finally {
      this.sonarrTesting.set(false);
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

    // Persist before launching so the next reload of the page pre-fills.
    await this.saveRadarrCredentials();

    this.radarrLoading.set(true);
    this.radarrResult.set(null);
    this.radarrError.set('');
    try {
      const result = await firstValueFrom(
        this.http.post<ArrImportResult>('/api/imports/radarr', {
          url,
          apiKey,
          mode: this.radarrMode(),
          importSubtitles: this.radarrImportSubs(),
          ...this.libraryBody(
            this.radarrLibrary(),
            this.radarrNewLibraryName(),
          ),
        }),
      );
      this.radarrResult.set(result);
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      this.radarrError.set(
        httpErr.error?.message ?? this.translate.instant('import.error'),
      );
    } finally {
      this.radarrLoading.set(false);
    }
  }

  async importSonarr() {
    const url = this.sonarrUrl().trim();
    const apiKey = this.sonarrApiKey().trim();
    if (!url || !apiKey) return;

    // Persist before launching so the next reload of the page pre-fills.
    await this.saveSonarrCredentials();

    this.sonarrLoading.set(true);
    this.sonarrResult.set(null);
    this.sonarrError.set('');
    try {
      const result = await firstValueFrom(
        this.http.post<ArrImportResult>('/api/imports/sonarr', {
          url,
          apiKey,
          mode: this.sonarrMode(),
          importSubtitles: this.sonarrImportSubs(),
          ...this.libraryBody(
            this.sonarrLibrary(),
            this.sonarrNewLibraryName(),
          ),
        }),
      );
      this.sonarrResult.set(result);
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      this.sonarrError.set(
        httpErr.error?.message ?? this.translate.instant('import.error'),
      );
    } finally {
      this.sonarrLoading.set(false);
    }
  }
}
