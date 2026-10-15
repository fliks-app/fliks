import {
  Component,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TvSelectDirective } from '../../../shared/directives/tv-select.directive';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucideDownload } from '@lucide/angular';
import { firstValueFrom } from 'rxjs';
import { ImportDiskComponent } from '../../import-disk/import-disk';
import { SeerrApiService } from '../../../core/services/api/seerr-api.service';
import { SettingsApiService, settingsSecretsSet } from '../../../core/services/api/settings-api.service';
import { LibrariesApiService, Library } from '../../../core/services/api/libraries-api.service';
import {
  MediaServersApiService,
  MediaServerRow,
} from '../../../core/services/api/media-servers-api.service';
import { SseService } from '../../../core/services/sse.service';
import { ToastService } from '../../../core/services/toast.service';
import { SECRET_MASK } from '../../../shared/components/schema-form/schema-form';
import { ModalFooterComponent } from '../../../shared/components/modal-footer';
import { ModalHeaderComponent } from '../../../shared/components/modal-header';

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

interface PathMapping {
  remotePath: string;
  localLibraryId: number | null;
  ignore?: boolean;
}

interface PreviewRow {
  remotePath: string;
  suggestedLocalLibraryId: number | null;
}

interface PreviewImportResult {
  remoteRootFolders: PreviewRow[];
  localLibraries: { id: number; name: string; path: string | null }[];
}

type Provider = 'radarr' | 'sonarr';

/** Sentinel passed through the mapping select in place of a numeric library id. */
const IGNORE_VALUE = '__ignore__' as const;
type MappingSelectValue = number | typeof IGNORE_VALUE | null;

/** `null` means no library selected yet; the import button stays disabled. */
type LibrarySelection = number | null;

@Component({
  selector: 'app-data-imports-settings',
  imports: [TvSelectDirective, 
    ModalHeaderComponent,
    ModalFooterComponent,
    FormsModule,
    NgTemplateOutlet,
    TranslatePipe,
    LucideDownload,
    ImportDiskComponent,
  ],
  templateUrl: './data-imports.html',
})
export class DataImportsSettingsComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly settingsApi = inject(SettingsApiService);
  private readonly seerrApi = inject(SeerrApiService);
  private readonly librariesApi = inject(LibrariesApiService);
  private readonly mediaServersApi = inject(MediaServersApiService);
  private readonly sse = inject(SseService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  readonly loading = signal(true);
  readonly secretMask = SECRET_MASK;
  /** Keys the server holds but does not return; blank on save keeps them. */
  readonly storedKeys = signal<ReadonlySet<string>>(new Set());
  /** Stored keys the user chose to erase on the next save. */
  readonly clearedKeys = signal<ReadonlySet<string>>(new Set());

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
  readonly sonarrLoading = signal(false);
  readonly sonarrSaving = signal(false);
  readonly sonarrTesting = signal(false);
  readonly sonarrTestResult = signal<{
    ok: boolean;
    message: string;
  } | null>(null);
  readonly sonarrResult = signal<ArrImportResult | null>(null);
  readonly sonarrError = signal('');

  // ---- Path mapping wizard ----
  readonly radarrPreview = signal<PreviewImportResult | null>(null);
  readonly radarrMappings = signal<PathMapping[]>([]);
  readonly radarrPreviewing = signal(false);
  readonly radarrShowWizard = signal(false);
  readonly radarrCanConfirm = computed(() =>
    this.radarrMappings().every((m) => m.ignore || m.localLibraryId != null),
  );

  readonly sonarrPreview = signal<PreviewImportResult | null>(null);
  readonly sonarrMappings = signal<PathMapping[]>([]);
  readonly sonarrPreviewing = signal(false);
  readonly sonarrShowWizard = signal(false);
  readonly sonarrCanConfirm = computed(() =>
    this.sonarrMappings().every((m) => m.ignore || m.localLibraryId != null),
  );

  readonly IGNORE_VALUE = IGNORE_VALUE;

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
        this.translate.instant('settings.data_imports.emby.import_completed', {
          users: Number(event['users'] ?? 0),
          usersCreated: Number(event['usersCreated'] ?? 0),
          imported: Number(event['imported'] ?? 0),
          skipped: Number(event['skipped'] ?? 0),
        }),
      );
      return;
    }
    if (event.type === 'watch-history.import.failed') {
      this.setEmbyImporting(Number(event['serverId']), false);
      const err = (event['error'] as string | undefined) ?? this.translate.instant('common.error');
      this.toast.error(
        this.translate.instant('settings.data_imports.emby.import_failed', { error: err }),
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
        this.translate.instant('settings.data_imports.seerr.import_completed', summary),
      );
    } else if (event.type === 'seerr.import.failed') {
      this.seerrImporting.set(false);
      const err = (event['error'] as string | undefined) ?? this.translate.instant('common.error');
      this.toast.error(
        this.translate.instant('settings.data_imports.seerr.import_failed', { error: err }),
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
      this.storedKeys.set(
        new Set([
          ...settingsSecretsSet(all),
          ...[SETTING_SEERR_API_KEY, SETTING_RADARR_API_KEY, SETTING_SONARR_API_KEY].filter(
            (k) => !!all[k],
          ),
        ]),
      );
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

  // A reconnect cannot prove an import is still running, and an enabled button
  // with no toast beats a spinner that never stops.
  private readonly reconnectClearsImporting = effect(() => {
    if (!this.sse.connectionId()) return;
    untracked(() => {
      this.embyImportingIds.set(new Set());
      this.seerrImporting.set(false);
    });
  });

  async importEmbyWatchHistory(server: MediaServerRow) {
    if (this.embyImportingIds().has(server.id)) return;
    this.setEmbyImporting(server.id, true);
    try {
      await this.mediaServersApi.importWatchHistory(server.id);
      this.toast.success(
        this.translate.instant('settings.data_imports.emby.import_started', { name: server.name }),
      );
    } catch (err: unknown) {
      this.setEmbyImporting(server.id, false);
      const httpErr = err as { error?: { message?: string } };
      this.toast.error(
        httpErr.error?.message ??
          this.translate.instant('settings.data_imports.emby.import_failed', { error: '' }),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Seerr
  // ---------------------------------------------------------------------------

  private hasKey(setting: string, typed: string): boolean {
    const kept = this.storedKeys().has(setting) && !this.clearedKeys().has(setting);
    return typed.trim().length > 0 || kept;
  }

  /** Save also covers a pending clear, so a stored key counts even when cleared. */
  private canSave(url: string, setting: string, typed: string): boolean {
    return url.trim().length > 0 && (typed.trim().length > 0 || this.storedKeys().has(setting));
  }

  keyStored(p: 'seerr' | Provider): boolean {
    return this.storedKeys().has(`${p}_api_key`);
  }

  keyCleared(p: 'seerr' | Provider): boolean {
    return this.clearedKeys().has(`${p}_api_key`);
  }

  /** Clearing empties the field; typing a new key or "keep" cancels it. */
  setKeyCleared(p: 'seerr' | Provider, cleared: boolean) {
    this.clearedKeys.update((s) => {
      const next = new Set(s);
      if (cleared) next.add(`${p}_api_key`);
      else next.delete(`${p}_api_key`);
      return next;
    });
    if (cleared) this.keySig(p).set('');
  }

  onKeyInput(p: 'seerr' | Provider, value: string) {
    this.keySig(p).set(value);
    if (value.trim()) this.setKeyCleared(p, false);
  }

  private keySig(p: 'seerr' | Provider) {
    return p === 'seerr' ? this.seerrApiKey : this.apiKeySig(p);
  }

  private markStored(setting: string, typed: string) {
    if (typed.trim()) this.storedKeys.update((s) => new Set(s).add(setting));
    else if (this.clearedKeys().has(setting)) {
      this.storedKeys.update((s) => new Set([...s].filter((k) => k !== setting)));
      this.clearedKeys.update((s) => new Set([...s].filter((k) => k !== setting)));
    }
  }

  /** Blank leaves a stored key alone: omit it from the write and from the request body. */
  private keyEntry<K extends string>(name: K, typed: string, setting: string) {
    const v = typed.trim();
    if (!v && this.clearedKeys().has(setting)) return { [name]: null };
    return v || !this.storedKeys().has(setting) ? { [name]: v } : {};
  }

  get canSaveSeerr(): boolean {
    return this.canSave(this.seerrUrl(), SETTING_SEERR_API_KEY, this.seerrApiKey());
  }

  get canSubmitSeerr(): boolean {
    return this.seerrUrl().trim().length > 0 && this.hasKey(SETTING_SEERR_API_KEY, this.seerrApiKey());
  }

  async saveSeerrCredentials() {
    if (this.seerrSaving()) return;
    this.seerrSaving.set(true);
    try {
      await this.settingsApi.setBulk({
        [SETTING_SEERR_URL]: this.seerrUrl().trim().replace(/\/$/, ''),
        ...this.keyEntry(SETTING_SEERR_API_KEY, this.seerrApiKey(), SETTING_SEERR_API_KEY),
      });
      this.markStored(SETTING_SEERR_API_KEY, this.seerrApiKey());
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
        this.seerrApiKey().trim() || undefined,
      );
      this.seerrTestResult.set(r);
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      this.seerrTestResult.set({
        ok: false,
        message: httpErr.error?.message ?? this.translate.instant('common.error'),
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
      this.toast.success(this.translate.instant('settings.data_imports.seerr.import_started'));
    } catch (err: unknown) {
      this.seerrImporting.set(false);
      const httpErr = err as { error?: { message?: string } };
      this.toast.error(
        httpErr.error?.message ??
          this.translate.instant('settings.data_imports.seerr.import_failed', { error: '' }),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Radarr / Sonarr
  // ---------------------------------------------------------------------------

  get canSaveRadarr(): boolean {
    return this.canSave(this.radarrUrl(), SETTING_RADARR_API_KEY, this.radarrApiKey());
  }

  get canSubmitRadarr(): boolean {
    return this.radarrUrl().trim().length > 0 && this.hasKey(SETTING_RADARR_API_KEY, this.radarrApiKey());
  }

  /** Import-specific gate: credentials AND a picked target library. */
  get canImportRadarr(): boolean {
    return this.canSubmitRadarr && this.radarrLibrary() != null;
  }

  get canSaveSonarr(): boolean {
    return this.canSave(this.sonarrUrl(), SETTING_SONARR_API_KEY, this.sonarrApiKey());
  }

  get canSubmitSonarr(): boolean {
    return this.sonarrUrl().trim().length > 0 && this.hasKey(SETTING_SONARR_API_KEY, this.sonarrApiKey());
  }

  get canImportSonarr(): boolean {
    return this.canSubmitSonarr && this.sonarrLibrary() != null;
  }

  async saveRadarrCredentials() {
    if (this.radarrSaving()) return;
    this.radarrSaving.set(true);
    try {
      await this.settingsApi.setBulk({
        [SETTING_RADARR_URL]: this.radarrUrl().trim().replace(/\/$/, ''),
        ...this.keyEntry(SETTING_RADARR_API_KEY, this.radarrApiKey(), SETTING_RADARR_API_KEY),
      });
      this.markStored(SETTING_RADARR_API_KEY, this.radarrApiKey());
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
        this.http.post<{ ok: boolean; message: string }>('/api/imports/radarr/test', {
          url: this.radarrUrl().trim().replace(/\/$/, ''),
          ...this.keyEntry('apiKey', this.radarrApiKey(), SETTING_RADARR_API_KEY),
        }),
      );
      this.radarrTestResult.set(r);
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      this.radarrTestResult.set({
        ok: false,
        message: httpErr.error?.message ?? this.translate.instant('common.error'),
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
        ...this.keyEntry(SETTING_SONARR_API_KEY, this.sonarrApiKey(), SETTING_SONARR_API_KEY),
      });
      this.markStored(SETTING_SONARR_API_KEY, this.sonarrApiKey());
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
        this.http.post<{ ok: boolean; message: string }>('/api/imports/sonarr/test', {
          url: this.sonarrUrl().trim().replace(/\/$/, ''),
          ...this.keyEntry('apiKey', this.sonarrApiKey(), SETTING_SONARR_API_KEY),
        }),
      );
      this.sonarrTestResult.set(r);
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      this.sonarrTestResult.set({
        ok: false,
        message: httpErr.error?.message ?? this.translate.instant('common.error'),
      });
    } finally {
      this.sonarrTesting.set(false);
    }
  }

  private libraryBody(sel: LibrarySelection) {
    return typeof sel === 'number' ? { targetLibraryId: sel } : {};
  }

  /**
   * Step 1 of the import: ask the backend for *arr root folders + suggestions.
   * Three branches:
   *   - *arr exposes 0 root folders → skip the wizard and import with empty mappings
   *   - Fliks has 0 root folders     → open wizard in "no roots configured" state
   *   - otherwise                    → open wizard with one row per remote root
   */
  async openRadarrWizard() {
    await this.openWizard('radarr');
  }

  async openSonarrWizard() {
    await this.openWizard('sonarr');
  }

  private async openWizard(provider: Provider) {
    const url = this.urlSig(provider)().trim();
    const canSubmit = provider === 'radarr' ? this.canSubmitRadarr : this.canSubmitSonarr;
    if (!url || !canSubmit) return;
    const apiKey = this.keyEntry(
      'apiKey',
      this.apiKeySig(provider)(),
      provider === 'radarr' ? SETTING_RADARR_API_KEY : SETTING_SONARR_API_KEY,
    );

    if (provider === 'radarr') await this.saveRadarrCredentials();
    else await this.saveSonarrCredentials();

    this.previewingSig(provider).set(true);
    this.errorSig(provider).set('');
    this.resultSig(provider).set(null);
    try {
      const preview = await firstValueFrom(
        this.http.post<PreviewImportResult>(`/api/imports/${provider}/preview`, { url, ...apiKey }),
      );
      this.previewSig(provider).set(preview);
      if (preview.remoteRootFolders.length === 0) {
        await this.confirmImport(provider, []);
        return;
      }
      this.mappingsSig(provider).set(
        preview.remoteRootFolders.map((row) => ({
          remotePath: row.remotePath,
          localLibraryId: row.suggestedLocalLibraryId,
        })),
      );
      this.showWizardSig(provider).set(true);
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      this.errorSig(provider).set(
        httpErr.error?.message ?? this.translate.instant('import.path_wizard.preview_error'),
      );
    } finally {
      this.previewingSig(provider).set(false);
    }
  }

  cancelWizard(provider: Provider) {
    this.showWizardSig(provider).set(false);
    this.previewSig(provider).set(null);
    this.mappingsSig(provider).set([]);
  }

  /**
   * Empty-state CTA when the user has no compatible Fliks libraries. We
   * navigate programmatically because mixing `routerLink` with the `(click)`
   * handler that closes the wizard removed the anchor before Angular Router
   * had a chance to navigate, and the click was a no-op.
   */
  goToLibraries(provider: Provider) {
    this.cancelWizard(provider);
    void this.router.navigateByUrl('/settings/libraries');
  }

  setMapping(provider: Provider, remotePath: string, value: MappingSelectValue) {
    this.mappingsSig(provider).update((list) =>
      list.map((m) =>
        m.remotePath === remotePath
          ? value === IGNORE_VALUE
            ? { remotePath, localLibraryId: null, ignore: true }
            : { remotePath, localLibraryId: value }
          : m,
      ),
    );
  }

  /**
   * Filter libraries for the picker: only the import target is offered.
   * The backend enforces the same rule; this just hides unselectable options.
   */
  eligibleLocalLibraries(provider: Provider) {
    const preview = this.previewSig(provider)();
    if (!preview) return [];
    const target = provider === 'radarr' ? this.radarrLibrary() : this.sonarrLibrary();
    if (typeof target !== 'number') return [];
    return preview.localLibraries.filter((lib) => lib.id === target);
  }

  async confirmRadarrImport() {
    await this.confirmImport('radarr', this.radarrMappings());
  }

  async confirmSonarrImport() {
    await this.confirmImport('sonarr', this.sonarrMappings());
  }

  private async confirmImport(provider: Provider, mappings: PathMapping[]) {
    const url = this.urlSig(provider)().trim();
    const canSubmit = provider === 'radarr' ? this.canSubmitRadarr : this.canSubmitSonarr;
    if (!url || !canSubmit) return;
    const apiKey = this.keyEntry(
      'apiKey',
      this.apiKeySig(provider)(),
      provider === 'radarr' ? SETTING_RADARR_API_KEY : SETTING_SONARR_API_KEY,
    );

    this.showWizardSig(provider).set(false);
    this.loadingSig(provider).set(true);
    this.resultSig(provider).set(null);
    this.errorSig(provider).set('');

    const lib = provider === 'radarr' ? this.radarrLibrary() : this.sonarrLibrary();
    const mode = provider === 'radarr' ? this.radarrMode() : this.sonarrMode();
    const importSubs = provider === 'radarr' ? this.radarrImportSubs() : this.sonarrImportSubs();

    try {
      const result = await firstValueFrom(
        this.http.post<ArrImportResult>(`/api/imports/${provider}`, {
          url,
          ...apiKey,
          mode,
          importSubtitles: importSubs,
          pathMappings: mappings,
          ...this.libraryBody(lib),
        }),
      );
      this.resultSig(provider).set(result);
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      this.errorSig(provider).set(httpErr.error?.message ?? this.translate.instant('import.error'));
    } finally {
      this.loadingSig(provider).set(false);
    }
  }

  // ---- Provider signal accessors (avoids duplicating the wizard pipeline) ----

  private urlSig(p: Provider) {
    return p === 'radarr' ? this.radarrUrl : this.sonarrUrl;
  }
  private apiKeySig(p: Provider) {
    return p === 'radarr' ? this.radarrApiKey : this.sonarrApiKey;
  }
  private previewSig(p: Provider) {
    return p === 'radarr' ? this.radarrPreview : this.sonarrPreview;
  }
  private mappingsSig(p: Provider) {
    return p === 'radarr' ? this.radarrMappings : this.sonarrMappings;
  }
  private previewingSig(p: Provider) {
    return p === 'radarr' ? this.radarrPreviewing : this.sonarrPreviewing;
  }
  private showWizardSig(p: Provider) {
    return p === 'radarr' ? this.radarrShowWizard : this.sonarrShowWizard;
  }
  private loadingSig(p: Provider) {
    return p === 'radarr' ? this.radarrLoading : this.sonarrLoading;
  }
  private resultSig(p: Provider) {
    return p === 'radarr' ? this.radarrResult : this.sonarrResult;
  }
  private errorSig(p: Provider) {
    return p === 'radarr' ? this.radarrError : this.sonarrError;
  }
}
