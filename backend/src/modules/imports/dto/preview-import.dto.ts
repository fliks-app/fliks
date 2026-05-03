import { IsString, IsUrl } from 'class-validator';

export class PreviewImportDto {
  @IsUrl({ require_tld: false, require_protocol: true })
  url: string;

  @IsString()
  apiKey: string;
}

export interface PreviewRow {
  remotePath: string;
  suggestedLocalRootFolderId: number | null;
}

export interface PreviewImportResult {
  remoteRootFolders: PreviewRow[];
  localRootFolders: { id: number; path: string; libraryId: number | null }[];
}
