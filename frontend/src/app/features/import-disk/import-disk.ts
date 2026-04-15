import {
  Component,
  ChangeDetectionStrategy,
  signal,
  inject,
  computed,
  OnInit,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import { MediaService } from '../../core/services/api/media.service';
import { MediaType } from '../../core/enums/media-type.enum';

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
  force: boolean;
}

@Component({
  selector: 'app-import-disk',
  imports: [DecimalPipe, FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './import-disk.html',
})
export class ImportDiskComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly mediaApi = inject(MediaService);
  private readonly translate = inject(TranslateService);

  readonly folderPath = signal('');
  readonly scanning = signal(false);
  readonly scanError = signal('');
  readonly rows = signal<RowState[]>([]);
  readonly scanned = signal(false);

  readonly mediaOptions = signal<MediaOption[]>([]);
  readonly mediaOptionsLoading = signal(true);

  readonly importing = signal(false);
  readonly importResult = signal<{ imported: number; errors: string[] } | null>(null);

  readonly selectedCount = computed(() => this.rows().filter((r) => r.selected).length);

  async ngOnInit() {
    try {
      const page = await this.mediaApi.getAll({ limit: 2000, sortBy: 'title', sortOrder: 'ASC' });
      this.mediaOptions.set(
        page.data.map((m) => ({ id: m.id, title: m.title, year: m.year, type: m.type })),
      );
    } finally {
      this.mediaOptionsLoading.set(false);
    }
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
      rows.map((r, i) => (i === index ? { ...r, mediaId } : r)),
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
      .filter((r) => r.selected && r.mediaId !== null)
      .map((r) => ({
        filePath: r.candidate.filePath,
        mediaId: r.mediaId!,
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
          { imports: toImport },
        ),
      );
      this.importResult.set(result);
      // Remove successfully imported rows
      if (result.imported > 0) {
        this.rows.update((rows) => rows.filter((r) => !r.selected || r.mediaId === null));
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
