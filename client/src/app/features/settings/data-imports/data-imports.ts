import {
  Component,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TvSelectDirective } from '../../../shared/directives/tv-select.directive';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { TranslatePluralPipe, translatePlural } from '../../../core/pipes/translate-plural.pipe';
import { LucideDynamicIcon } from '@lucide/angular';
import { icons } from '../../../shared/icons';
import { firstValueFrom } from 'rxjs';
import { ImportDiskComponent } from '../../import-disk/import-disk';
import { ImportUserMappingComponent, type UnmappedUser, unmappedKey } from './user-mapping/user-mapping';
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
import { ModalComponent } from '../../../shared/components/modal';

const SETTING_SEERR_URL = 'seerr_url';
const SETTING_SEERR_API_KEY = 'seerr_api_key';
const SETTING_RADARR_URL = 'radarr_url';
const SETTING_RADARR_API_KEY = 'radarr_api_key';
const SETTING_SONARR_URL = 'sonarr_url';
const SETTING_SONARR_API_KEY = 'sonarr_api_key';
const SETTING_LIDARR_URL = 'lidarr_url';
const SETTING_LIDARR_API_KEY = 'lidarr_api_key';

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

type Provider = 'radarr' | 'sonarr' | 'lidarr';

/** Sentinel passed through the mapping select in place of a numeric library id. */
const IGNORE_VALUE = '__ignore__' as const;
type MappingSelectValue = number | typeof IGNORE_VALUE | null;

/** `null` means no library selected yet; the import button stays disabled. */
type LibrarySelection = number | null;

/** One *arr provider's form, last result and path-mapping wizard. */
class ArrState {
  readonly url = signal('');
  readonly apiKey = signal('');
  readonly mode = signal<'skip' | 'update'>('skip');
  readonly importSubs = signal(false);
  readonly library = signal<LibrarySelection>(null);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly testing = signal(false);
  readonly testResult = signal<{ ok: boolean; message: string } | null>(null);
  readonly result = signal<ArrImportResult | null>(null);
  readonly error = signal('');
  readonly preview = signal<PreviewImportResult | null>(null);
  readonly mappings = signal<PathMapping[]>([]);
  readonly previewing = signal(false);
  readonly showWizard = signal(false);
  readonly canConfirm = computed(() =>
    this.mappings().every((m) => m.ignore || m.localLibraryId != null),
  );
}

const ARR_SETTINGS: Record<Provider, { url: string; apiKey: string }> = {
  radarr: { url: SETTING_RADARR_URL, apiKey: SETTING_RADARR_API_KEY },
  sonarr: { url: SETTING_SONARR_URL, apiKey: SETTING_SONARR_API_KEY },
  lidarr: { url: SETTING_LIDARR_URL, apiKey: SETTING_LIDARR_API_KEY },
};

@Component({
  selector: 'app-data-imports-settings',
  imports: [ModalComponent, TvSelectDirective, 
    ModalHeaderComponent,
    ModalFooterComponent,
    FormsModule,
    NgTemplateOutlet,
    TranslatePipe, TranslatePluralPipe,
    ImportDiskComponent,
    ImportUserMappingComponent, LucideDynamicIcon,
  ],
  templateUrl: './data-imports.html',
})
export class DataImportsSettingsComponent implements OnInit {
  protected readonly icons = icons;

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

  // ---- Source users no account could take over (Seerr and Emby imports) ----
  /** Per import source (`seerr`, `emby:<server id>`): the listed users and the total the run counted. */
  private readonly unmappedBySource = signal<Record<string, { users: UnmappedUser[]; count: number }>>({});
  readonly unmappedUsers = computed(() => Object.values(this.unmappedBySource()).flatMap((g) => g.users));
  readonly unmappedCount = computed(() => Object.values(this.unmappedBySource()).reduce((n, g) => n + g.count, 0));
  readonly userMappingShown = signal(false);

  private noteUnmapped(source: string, event: Record<string, unknown>): void {
    const users = (event['unmapped'] as UnmappedUser[] | undefined) ?? [];
    const count = Number(event['unmappedCount'] ?? users.length);
    this.unmappedBySource.update((all) => ({ ...all, [source]: { users, count } }));
  }

  /** Importer errors per source: the messages sent with the event and the total the run counted. */
  private readonly errorsBySource = signal<Record<string, { messages: string[]; count: number }>>({});
  readonly importErrorCount = computed(() => Object.values(this.errorsBySource()).reduce((n, g) => n + g.count, 0));
  readonly importErrorMessages = computed(() =>
    Object.values(this.errorsBySource()).flatMap((g) => g.messages).slice(0, 5),
  );

  private noteErrors(source: string, event: Record<string, unknown>): void {
    const messages = ((event['errors'] as unknown[] | undefined) ?? []).map(String);
    const count = Number(event['errorCount'] ?? messages.length);
    this.errorsBySource.update((all) => ({ ...all, [source]: { messages, count } }));
  }

  importErrorsNotice(): string {
    return translatePlural(this.translate, 'settings.data_imports.errors_notice', this.importErrorCount());
  }

  onUserMapped(user: UnmappedUser): void {
    const key = unmappedKey(user);
    this.unmappedBySource.update((all) =>
      Object.fromEntries(
        Object.entries(all).map(([source, g]) => {
          const users = g.users.filter((u) => unmappedKey(u) !== key);
          return [source, { users, count: g.count - (g.users.length - users.length) }];
        }),
      ),
    );
  }

  unmappedNotice(): string {
    return translatePlural(this.translate, 'settings.data_imports.unmapped_notice', this.unmappedCount());
  }

  seerrSummaryText(s: SeerrSummary): string {
    return this.translate.instant('settings.data_imports.seerr.import_completed', {
      users: translatePlural(this.translate, 'settings.data_imports.users_created', s.users, { created: s.usersCreated }),
      imported: translatePlural(this.translate, 'settings.data_imports.requests_imported', s.imported),
      updated: s.updated,
      skipped: s.skipped,
    });
  }

  // ---- Radarr / Sonarr (and their path mapping wizards) ----
  readonly libraries = signal<Library[]>([]);
  readonly movieLibraries = computed(() =>
    this.libraries().filter((l) => l.mediaTypes.includes('movie')),
  );
  readonly seriesLibraries = computed(() =>
    this.libraries().filter((l) => l.mediaTypes.includes('series')),
  );

  readonly albumLibraries = computed(() =>
    this.libraries().filter((l) => (l.mediaTypes as readonly string[]).includes('album')),
  );

  readonly arr: Record<Provider, ArrState> = {
    radarr: new ArrState(),
    sonarr: new ArrState(),
    lidarr: new ArrState(),
  };
  readonly providers = ['radarr', 'sonarr', 'lidarr'] as const;
  readonly arrCards = [
    {
      provider: 'radarr',
      titleKey: 'import.radarr_title',
      descKey: 'import.radarr_desc',
      urlPlaceholderKey: 'import.radarr_url_placeholder',
      libraries: this.movieLibraries,
    },
    {
      provider: 'sonarr',
      titleKey: 'import.sonarr_title',
      descKey: 'import.sonarr_desc',
      urlPlaceholderKey: 'import.sonarr_url_placeholder',
      libraries: this.seriesLibraries,
    },
    {
      provider: 'lidarr',
      titleKey: 'import.lidarr_title',
      descKey: 'import.lidarr_desc',
      urlPlaceholderKey: 'import.lidarr_url_placeholder',
      libraries: this.albumLibraries,
    },
  ] as const;

  readonly IGNORE_VALUE = IGNORE_VALUE;

  // Listen for Seerr + Emby watch-history import SSE events. Toasts on
  // completion / failure and updates `importing` flags so buttons re-enable.
  private readonly importEvents = this.sse
    .on('watch-history.import.completed', 'watch-history.import.failed', 'seerr.import.completed', 'seerr.import.failed')
    .pipe(takeUntilDestroyed())
    .subscribe((event) => {
      if (event.type === 'watch-history.import.completed') {
        this.setEmbyImporting(Number(event['serverId']), false);
        const users = Number(event['users'] ?? 0);
        const created = Number(event['usersCreated'] ?? 0);
        const imported = Number(event['imported'] ?? 0);
        this.noteUnmapped(`emby:${event['serverId']}`, event);
        this.noteErrors(`emby:${event['serverId']}`, event);
        this.toast.success(
          this.translate.instant('settings.data_imports.emby.import_completed', {
            users: translatePlural(this.translate, 'settings.data_imports.users_created', users, { created }),
            imported: translatePlural(this.translate, 'settings.data_imports.views_imported', imported),
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
        this.noteUnmapped('seerr', event);
        this.noteErrors('seerr', event);
        this.toast.success(this.seerrSummaryText(summary));
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
          ...[
            SETTING_SEERR_API_KEY,
            SETTING_RADARR_API_KEY,
            SETTING_SONARR_API_KEY,
            SETTING_LIDARR_API_KEY,
          ].filter((k) => !!all[k]),
        ]),
      );
      for (const p of ['radarr', 'sonarr', 'lidarr'] as const) {
        this.arr[p].url.set(all[ARR_SETTINGS[p].url] ?? '');
        this.arr[p].apiKey.set(all[ARR_SETTINGS[p].apiKey] ?? '');
      }
      this.libraries.set(libs);
      this.embyServers.set(servers.filter((s) => s.type === 'emby'));
    } finally {
      this.loading.set(false);
    }
  }

  // ---- Emby watch history ----

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

  // ---- Seerr ----

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
    return p === 'seerr' ? this.seerrApiKey : this.arr[p].apiKey;
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

  // ---- Radarr / Sonarr ----

  arrCanSave(p: Provider): boolean {
    const st = this.arr[p];
    return this.canSave(st.url(), ARR_SETTINGS[p].apiKey, st.apiKey());
  }

  arrCanSubmit(p: Provider): boolean {
    const st = this.arr[p];
    return st.url().trim().length > 0 && this.hasKey(ARR_SETTINGS[p].apiKey, st.apiKey());
  }

  /** Import-specific gate: credentials AND a picked target library. */
  arrCanImport(p: Provider): boolean {
    return this.arrCanSubmit(p) && this.arr[p].library() != null;
  }

  async saveArrCredentials(p: Provider) {
    const st = this.arr[p];
    const keys = ARR_SETTINGS[p];
    if (st.saving()) return;
    st.saving.set(true);
    try {
      await this.settingsApi.setBulk({
        [keys.url]: st.url().trim().replace(/\/$/, ''),
        ...this.keyEntry(keys.apiKey, st.apiKey(), keys.apiKey),
      });
      this.markStored(keys.apiKey, st.apiKey());
      this.toast.success(this.translate.instant('common.saved'));
    } finally {
      st.saving.set(false);
    }
  }

  async testArr(p: Provider) {
    const st = this.arr[p];
    if (!this.arrCanSubmit(p) || st.testing()) return;
    st.testing.set(true);
    st.testResult.set(null);
    try {
      const r = await firstValueFrom(
        this.http.post<{ ok: boolean; message: string }>(`/api/imports/${p}/test`, {
          url: st.url().trim().replace(/\/$/, ''),
          ...this.keyEntry('apiKey', st.apiKey(), ARR_SETTINGS[p].apiKey),
        }),
      );
      st.testResult.set(r);
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      st.testResult.set({
        ok: false,
        message: httpErr.error?.message ?? this.translate.instant('common.error'),
      });
    } finally {
      st.testing.set(false);
    }
  }

  private libraryBody(sel: LibrarySelection) {
    return typeof sel === 'number' ? { targetLibraryId: sel } : {};
  }

  /** Import step 1: fetch *arr root folders and suggestions; 0 *arr roots imports with empty mappings, 0 Fliks roots opens the wizard in "no roots" state. */
  async openWizard(provider: Provider) {
    const st = this.arr[provider];
    const url = st.url().trim();
    if (!url || !this.arrCanSubmit(provider)) return;
    const apiKey = this.keyEntry('apiKey', st.apiKey(), ARR_SETTINGS[provider].apiKey);

    await this.saveArrCredentials(provider);

    st.previewing.set(true);
    st.error.set('');
    st.result.set(null);
    try {
      const preview = await firstValueFrom(
        this.http.post<PreviewImportResult>(`/api/imports/${provider}/preview`, { url, ...apiKey }),
      );
      st.preview.set(preview);
      if (preview.remoteRootFolders.length === 0) {
        await this.confirmImport(provider, []);
        return;
      }
      st.mappings.set(
        preview.remoteRootFolders.map((row) => ({
          remotePath: row.remotePath,
          localLibraryId: row.suggestedLocalLibraryId,
        })),
      );
      st.showWizard.set(true);
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      st.error.set(
        httpErr.error?.message ?? this.translate.instant('import.path_wizard.preview_error'),
      );
    } finally {
      st.previewing.set(false);
    }
  }

  cancelWizard(provider: Provider) {
    const st = this.arr[provider];
    st.showWizard.set(false);
    st.preview.set(null);
    st.mappings.set([]);
  }

  /** Empty-state CTA: navigates programmatically because `routerLink` plus the wizard-closing `(click)` removed the anchor before the router ran. */
  goToLibraries(provider: Provider) {
    this.cancelWizard(provider);
    void this.router.navigateByUrl('/settings/libraries');
  }

  setMapping(provider: Provider, remotePath: string, value: MappingSelectValue) {
    this.arr[provider].mappings.update((list) =>
      list.map((m) =>
        m.remotePath === remotePath
          ? value === IGNORE_VALUE
            ? { remotePath, localLibraryId: null, ignore: true }
            : { remotePath, localLibraryId: value }
          : m,
      ),
    );
  }

  /** Libraries offered by the picker: only the import target (the backend enforces the same rule). */
  eligibleLocalLibraries(provider: Provider) {
    const st = this.arr[provider];
    const preview = st.preview();
    if (!preview) return [];
    const target = st.library();
    if (typeof target !== 'number') return [];
    return preview.localLibraries.filter((lib) => lib.id === target);
  }

  async confirmArrImport(provider: Provider) {
    await this.confirmImport(provider, this.arr[provider].mappings());
  }

  private async confirmImport(provider: Provider, mappings: PathMapping[]) {
    const st = this.arr[provider];
    const url = st.url().trim();
    if (!url || !this.arrCanSubmit(provider)) return;
    const apiKey = this.keyEntry('apiKey', st.apiKey(), ARR_SETTINGS[provider].apiKey);

    st.showWizard.set(false);
    st.loading.set(true);
    st.result.set(null);
    st.error.set('');

    try {
      const result = await firstValueFrom(
        this.http.post<ArrImportResult>(`/api/imports/${provider}`, {
          url,
          ...apiKey,
          mode: st.mode(),
          importSubtitles: st.importSubs(),
          pathMappings: mappings,
          ...this.libraryBody(st.library()),
        }),
      );
      st.result.set(result);
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      st.error.set(httpErr.error?.message ?? this.translate.instant('import.error'));
    } finally {
      st.loading.set(false);
    }
  }
}
