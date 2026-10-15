import { IsOptional, IsString, IsUrl } from 'class-validator';

export class PreviewImportDto {
  @IsUrl({ require_tld: false, require_protocol: true })
  url: string;

  /** Absent or blank: the stored setting is used. */
  @IsOptional()
  @IsString()
  apiKey?: string;
}

export interface PreviewRow {
  remotePath: string;
  suggestedLocalLibraryId: number | null;
}

export interface PreviewImportResult {
  remoteRootFolders: PreviewRow[];
  localLibraries: { id: number; name: string; path: string | null }[];
}
