export interface SubtitleSearchParams {
  imdbId?: string;
  tmdbId?: number;
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  language: string;
  filePath?: string;
  moviehash?: string;
  moviebytesize?: number;
}

export interface SubtitleSearchResult {
  providerFileId: string;
  title: string;
  language: string;
  forced: boolean;
  hearingImpaired: boolean;
  score: number;
  downloadCount?: number;
  providerName: string;
  providerType: string;
}

export interface SubtitleProviderInterface {
  search(params: SubtitleSearchParams): Promise<SubtitleSearchResult[]>;
  download(result: SubtitleSearchResult): Promise<Buffer>;
  testConnection(settings: Record<string, unknown>): Promise<boolean>;
}
