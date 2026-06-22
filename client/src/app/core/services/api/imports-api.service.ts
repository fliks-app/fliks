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
  libraryId: number;
  libraryPath: string;
  groups: OrphanGroup[];
  looseFiles: OrphanFileEntry[];
  scannedFiles: number;
  orphanCount: number;
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
  externalId: string;
  provider?: string;
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

  relinkOrphans(body: RelinkOrphansBody) {
    return firstValueFrom(
      this.http.post<RelinkResult>('/api/imports/library/orphans/relink', body),
    );
  }
}
