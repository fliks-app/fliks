export interface ImportFileEntry {
  filePath: string;
  mediaId: number;
  episodeId?: number;
  quality: string;
  /** Library that owns the destination. The file is copied/moved under
   *  its root folder, never registered in place. */
  targetLibraryId: number;
  force?: boolean;
}
