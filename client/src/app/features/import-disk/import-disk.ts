import {
  Component,
  signal,
  inject,
  computed,
  OnInit,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { TvSelectDirective } from '../../shared/directives/tv-select.directive';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import { MediaService } from '../../core/services/api/media.service';
import { FolderPickerService } from '../../core/services/folder-picker.service';
import { LibrariesApiService, Library } from '../../core/services/api/libraries-api.service';
import { MediaType } from '../../core/enums/media-type.enum';
import {
  SearchableSelectComponent,
  SearchableSelectOption,
} from '../../shared/components/forms/searchable-select/searchable-select';

export interface ScanCandidate {
  filePath: string;
  filename: string;
  size: number;
  qualityName: string;
  qualityId: number;
  seasonNumber: number | null;
  episodeNumber: number | null;
  mediaId: number | null;
  mediaTitle: string | null;
  mediaYear: number | null;
  mediaType: string | null;
  episodeId: number | null;
  episodeTitle: string | null;
  existingQuality: string | null;
}

interface MediaOption {
  id: number;
  title: string;
  year: number;
  type: MediaType;
}

interface RowState {
  candidate: ScanCandidate;
  selected: boolean;
  mediaId: number | null;
  targetLibraryId: number | null;
  force: boolean;
}

export type ImportMethod = 'copy' | 'move';

@Component({
  selector: 'app-import-disk',
  imports: [TvSelectDirective, DecimalPipe, FormsModule, TranslatePipe, SearchableSelectComponent],
  templateUrl: './import-disk.html',
})
export class ImportDiskComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly folderPicker = inject(FolderPickerService);
  private readonly mediaApi = inject(MediaService);
  private readonly librariesApi = inject(LibrariesApiService);
  private readonly translate = inject(TranslateService);

  readonly folderPath = signal('');
  readonly scanning = signal(false);
  readonly scanError = signal('');
  readonly rows = signal<RowState[]>([]);
  readonly scanned = signal(false);
  readonly method = signal<ImportMethod>('copy');

  readonly mediaOptions = signal<MediaOption[]>([]);
  readonly mediaOptionsLoading = signal(true);
  readonly libraries = signal<Library[]>([]);

  readonly importing = signal(false);
  readonly importResult = signal<{ imported: number; errors: string[] } | null>(null);

  readonly selectedCount = computed(() => this.rows().filter((r) => r.selected).length);

  /** Media list mapped to the searchable-select shape (id → display label). */
  readonly mediaSelectOptions = computed<SearchableSelectOption[]>(() =>
    this.mediaOptions().map((m) => ({ value: m.id, label: this.mediaLabel(m) })),
  );
  /** Selected rows that are missing a media / library — block the import button. */
  readonly invalidSelectedCount = computed(
    () =>
      this.rows().filter(
        (r) => r.selected && (r.mediaId == null || r.targetLibraryId == null),
      ).length,
  );

  librariesForRow(row: RowState): Library[] {
    const type = this.mediaTypeForRow(row);
    if (!type) return this.libraries();
    return this.libraries().filter((l) => l.mediaTypes.includes(type));
  }

  private mediaTypeForRow(row: RowState): 'movie' | 'series' | null {
    if (row.candidate.mediaType === 'movie' || row.candidate.mediaType === 'series') {
      return row.candidate.mediaType;
    }
    const opt = this.mediaOptions().find((m) => m.id === row.mediaId);
    return opt ? (opt.type as 'movie' | 'series') : null;
  }

  private defaultLibraryForType(type: 'movie' | 'series' | null): number | null {
    if (!type) return null;
    const def = this.libraries().find((l) =>
      type === 'movie' ? l.isDefaultForMovies : l.isDefaultForSeries,
    );
    if (def && def.mediaTypes.includes(type)) return def.id;
    // No default → first library accepting this type.
    const first = this.libraries().find((l) => l.mediaTypes.includes(type));
    return first?.id ?? null;
  }

  async ngOnInit() {
    try {
      const [page, libs] = await Promise.all([
        this.mediaApi.getAll({ limit: 2000, sortBy: 'title', sortOrder: 'ASC' }),
        this.librariesApi.list().catch(() => [] as Library[]),
      ]);
      this.mediaOptions.set(
        page.data.map((m) => ({ id: m.id, title: m.title, year: m.year, type: m.type })),
      );
      this.libraries.set(libs);
    } finally {
      this.mediaOptionsLoading.set(false);
    }
  }

  async browse() {
    const picked = await this.folderPicker.open(this.folderPath().trim());
    if (picked) this.folderPath.set(picked);
  }

  async scan() {
    const folder = this.folderPath().trim();
    if (!folder) return;
    this.scanning.set(true);
    this.scanError.set('');
    this.rows.set([]);
    this.scanned.set(false);
    this.importResult.set(null);
    try {
      const candidates = await firstValueFrom(
        this.http.post<ScanCandidate[]>('/api/imports/disk/scan', { folderPath: folder }),
      );
      this.rows.set(
        candidates.map((c) => ({
          candidate: c,
          selected: c.mediaId !== null && !c.existingQuality,
          mediaId: c.mediaId,
          targetLibraryId: this.defaultLibraryForType(
            (c.mediaType as 'movie' | 'series' | null) ?? null,
          ),
          force: false,
        })),
      );
      this.scanned.set(true);
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      this.scanError.set(
        httpErr.error?.message ?? this.translate.instant('import_disk.scan_error'),
      );
    } finally {
      this.scanning.set(false);
    }
  }

  toggleAll(checked: boolean) {
    this.rows.update((rows) =>
      rows.map((r) => ({
        ...r,
        selected: checked && (!r.candidate.existingQuality || r.force),
      })),
    );
  }

  setRowMedia(index: number, mediaId: number | null) {
    this.rows.update((rows) =>
      rows.map((r, i) => {
        if (i !== index) return r;
        // Recompute the default library when switching media — the new
        // pick may flip movie/series and the library set differs.
        const opt = this.mediaOptions().find((m) => m.id === mediaId);
        const type: 'movie' | 'series' | null = opt
          ? (opt.type as 'movie' | 'series')
          : ((r.candidate.mediaType as 'movie' | 'series' | null) ?? null);
        const targetLibraryId =
          r.targetLibraryId != null &&
          this.libraries().some(
            (l) => l.id === r.targetLibraryId && (!type || l.mediaTypes.includes(type)),
          )
            ? r.targetLibraryId
            : this.defaultLibraryForType(type);
        return { ...r, mediaId, targetLibraryId };
      }),
    );
  }

  setRowLibrary(index: number, libraryId: number | null) {
    this.rows.update((rows) =>
      rows.map((r, i) => (i === index ? { ...r, targetLibraryId: libraryId } : r)),
    );
  }

  setRowSelected(index: number, selected: boolean) {
    this.rows.update((rows) =>
      rows.map((r, i) => (i === index ? { ...r, selected } : r)),
    );
  }

  forceImportRow(index: number) {
    this.rows.update((rows) =>
      rows.map((r, i) => (i === index ? { ...r, force: true, selected: true } : r)),
    );
  }

  async confirmImport() {
    const toImport = this.rows()
      .filter(
        (r) => r.selected && r.mediaId !== null && r.targetLibraryId !== null,
      )
      .map((r) => ({
        filePath: r.candidate.filePath,
        mediaId: r.mediaId!,
        targetLibraryId: r.targetLibraryId!,
        episodeId: r.candidate.episodeId ?? undefined,
        quality: r.candidate.qualityName,
        ...(r.force ? { force: true } : {}),
      }));

    if (!toImport.length) return;
    this.importing.set(true);
    this.importResult.set(null);
    try {
      const result = await firstValueFrom(
        this.http.post<{ imported: number; errors: string[] }>(
          '/api/imports/disk/confirm',
          { method: this.method(), imports: toImport },
        ),
      );
      this.importResult.set(result);
      // Remove successfully imported rows
      if (result.imported > 0) {
        this.rows.update((rows) =>
          rows.filter(
            (r) =>
              !r.selected || r.mediaId === null || r.targetLibraryId === null,
          ),
        );
      }
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      this.importResult.set({
        imported: 0,
        errors: [httpErr.error?.message ?? this.translate.instant('import_disk.import_error')],
      });
    } finally {
      this.importing.set(false);
    }
  }

  formatBytes(bytes: number): string {
    if (!bytes) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / Math.pow(1024, i)).toFixed(i >= 3 ? 1 : 0)} ${units[i]}`;
  }

  mediaLabel(opt: MediaOption): string {
    return `${opt.title}${opt.year ? ` (${opt.year})` : ''} — ${opt.type === 'movie' ? 'Film' : 'Série'}`;
  }
}
