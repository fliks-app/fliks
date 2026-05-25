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
  /** Local video file's release name (typically the file basename
   *  without extension). Forwarded by the orchestrator to the central
   *  scorer so it can compute per-attribute match credit
   *  (release_group, source, resolution, codecs). Providers ignore
   *  this; it only matters in SubtitlesService. */
  videoReleaseName?: string;
}

/**
 * Provider-returned subtitle candidate. Providers expose RAW metadata —
 * they no longer attempt to score the match themselves. `SubtitlesService`
 * rescores every candidate against the video file via the central scorer
 * so scores stay comparable across providers.
 */
export interface SubtitleSearchResult {
  providerFileId: string;
  /** Title as returned by the provider's listing (movie/episode name).
   *  Kept for compatibility; the scorer prefers `releaseName`. */
  title: string;
  /** Release name of the subtitle's source (e.g. `Show.S01E01.1080p.WEB-DL.x265-NTb`).
   *  Empty when the provider doesn't expose one — scoring falls back to
   *  language + imdb-equivalence credit only. */
  releaseName?: string;
  /** IMDB id reported by the provider for this candidate (no `tt`
   *  prefix required). Enables the equivalence map: title/year are
   *  credited when imdb matches the media. */
  imdbId?: string;
  /** True when the candidate came from a hash-based provider lookup
   *  (e.g. OpenSubtitles moviehash). Treated as a perfect match by the
   *  central scorer — credit hash + series/title/year + season/episode. */
  hashMatched?: boolean;
  language: string;
  forced: boolean;
  hearingImpaired: boolean;
  /** Normalised 0-100 score assigned by the central
   *  scorer in `SubtitlesService`. Providers must NOT set this — it is
   *  overwritten before the result list is returned to callers. */
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
