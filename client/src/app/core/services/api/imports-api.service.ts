import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { MediaType } from '../../enums/media-type.enum';

export interface OrphanFileEntry {
  filePath: string;
  filename: string;
  size: number;
  qualityName: string;
  qualityId: number;
  seasonNumber: number | null;
  episodeNumber: number | null;
  episodeEnd: number | null;
}

export interface OrphanNfoIds {
  tmdbId?: number;
  imdbId?: string;
  tvdbId?: number;
  title?: string;
  year?: number;
}

export interface OrphanGroup {
  groupKey: string;
  mediaType: MediaType;
  folderName: string;
  guessTitle: string | null;
  guessYear: number | null;
  nfo: OrphanNfoIds | null;
  suggestedProvider: string;
  files: OrphanFileEntry[];
}

export interface OrphanScanResult {
  libraryPath: string;
  groups: OrphanGroup[];
  scannedFiles: number;
  orphanCount: number;
}

export interface PreviewOrphansBody {
  path: string;
  mediaTypes?: MediaType[];
  preferredProvider?: string | null;
}

export interface RelinkFile {
  filePath: string;
  seasonNumber?: number;
  episodeNumber?: number;
  episodeEnd?: number;
}

export interface RelinkOrphansBody {
  libraryId: number;
  type: MediaType;
  externalId?: string;
  provider?: string;
  /** Used only when `externalId` is absent, to create an unmatched title. */
  title?: string;
  year?: number;
  qualityProfileId?: number;
  languageProfileId?: number;
  folderName: string;
  reorganize?: boolean;
  files: RelinkFile[];
}

export interface RelinkResult {
  mediaId: number;
  created: boolean;
  linked: number;
  errors: string[];
}

@Injectable({ providedIn: 'root' })
export class ImportsApiService {
  private readonly http = inject(HttpClient);

  scanOrphans(libraryId: number) {
    return firstValueFrom(
      this.http.post<OrphanScanResult>(
        `/api/imports/library/${libraryId}/orphans/scan`,
        {},
      ),
    );
  }

  /** Scan a bare folder, for a library that does not exist yet. */
  previewOrphans(body: PreviewOrphansBody) {
    return firstValueFrom(
      this.http.post<OrphanScanResult>('/api/imports/orphans/preview', body),
    );
  }

  /** Queue every group of a scan; the server imports them in the background. */
  relinkOrphansBatch(items: RelinkOrphansBody[]) {
    return firstValueFrom(
      this.http.post<{ queued: number }>(
        '/api/imports/library/orphans/relink-batch',
        { items },
      ),
    );
  }

  relinkOrphans(body: RelinkOrphansBody) {
    return firstValueFrom(
      this.http.post<RelinkResult>('/api/imports/library/orphans/relink', body),
    );
  }
}
