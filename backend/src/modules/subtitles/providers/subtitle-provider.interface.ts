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
  /** Per-language hearing-impaired preference: `prefer` / `avoid` flip
   *  the 1-point scorer bit; `require` / `forbid` filter candidates
   *  in the orchestrator before scoring. Default `avoid`. */
  hearingImpairedMode?: 'prefer' | 'avoid' | 'require' | 'forbid';
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

export interface SubtitleProviderTestResult {
  ok: boolean;
  /** Technical reason, shown as-is next to the translated verdict: an HTTP status,
   *  a missing credential, a network error. Absent on success. */
  detail?: string;
}

/** Providers report their probe verdict through this so the failing status reaches the UI. */
export async function testResultFromResponse(
  res: Response,
): Promise<SubtitleProviderTestResult> {
  if (res.ok) return { ok: true };
  const reason = await responseMessage(res);
  const status = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
  return {
    ok: false,
    detail: reason ? `HTTP ${res.status}: ${reason}` : status,
  };
}

/** Providers state their reason in a JSON body ("invalid username/password"); an HTML error
 *  page or an unreadable stream leaves the status to speak alone. */
async function responseMessage(res: Response): Promise<string | undefined> {
  try {
    const body: unknown = await res.json();
    if (!body || typeof body !== 'object') return undefined;
    const record = body as Record<string, unknown>;
    for (const key of ['message', 'error', 'detail', 'error_description']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim())
        return value.trim().slice(0, 200);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export interface SubtitleProviderInterface {
  search(params: SubtitleSearchParams): Promise<SubtitleSearchResult[]>;
  download(result: SubtitleSearchResult): Promise<Buffer>;
  testConnection(
    settings: Record<string, unknown>,
  ): Promise<SubtitleProviderTestResult>;
}
