import { MediaType } from '../../../common/enums';
import { NfoIds } from '../nfo-metadata.service';

/** One orphan video file found under a library root, with cheap hints. */
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

/**
 * A re-linkable unit: a single movie file, or all episode files sharing one
 * show folder. `folderName` is the on-disk folder (first path segment under
 * the library root) that the re-created media will be pinned to.
 */
export interface OrphanGroup {
  groupKey: string;
  mediaType: MediaType;
  folderName: string;
  guessTitle: string | null;
  guessYear: number | null;
  nfo: NfoIds | null;
  suggestedProvider: string;
  files: OrphanFileEntry[];
}

export interface OrphanScanResult {
  libraryId: number;
  libraryPath: string;
  groups: OrphanGroup[];
  /** Video files directly at the library root — not re-linkable in V1. */
  looseFiles: OrphanFileEntry[];
  scannedFiles: number;
  orphanCount: number;
}

export interface RelinkResult {
  mediaId: number;
  created: boolean;
  linked: number;
  errors: string[];
}
