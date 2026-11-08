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

/** An id the group's files name (a video's nfo, a book's ISBN or ASIN). */
export interface OrphanFileId {
  provider: string;
  externalId: string;
}

export interface OrphanGroup {
  groupKey: string;
  mediaType: MediaType;
  folderName: string;
  guessTitle: string | null;
  guessYear: number | null;
  /** Books only, absent when the file names no author. */
  guessAuthors?: string[];
  fileIds: OrphanFileId[];
  suggestedProvider: string;
  /** The library folder the group was found in; absent for a preview. */
  folderId?: number;
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

/** Files sit outside the library: copy or move them into its naming layout. */
export type TransferMethod = 'copy' | 'move';

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
  /** Batch only: with no `externalId`, the server takes the best hit of a search of `title`. */
  auto?: boolean;
  transfer?: TransferMethod;
  /** The folder this group was scanned from; caps a series-folder lookup on the server. */
  scanRoot?: string;
  folderId?: number;
  /** Absent for a series: the server walks `folderName` again. */
  files?: RelinkFile[];
}

export interface RelinkResult {
  mediaId: number;
  created: boolean;
  linked: number;
  /** Files already at their destination: a no-op re-run, not a failure. */
  alreadyPresent: number;
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
