import { IsString, IsUrl } from 'class-validator';

export class PreviewImportDto {
  @IsUrl({ require_tld: false, require_protocol: true })
  url: string;

  @IsString()
  apiKey: string;
}

export interface PreviewRow {
  remotePath: string;
  suggestedLocalLibraryId: number | null;
}

export interface PreviewImportResult {
  remoteRootFolders: PreviewRow[];
  localLibraries: { id: number; name: string; path: string | null }[];
}
