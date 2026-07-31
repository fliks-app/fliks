import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import {
  IMetadataProvider,
  MetadataSearchResult,
  MetadataDetails,
  SeasonDetails,
  PersonDetails,
  PersonCombinedCredits,
  PersonCreditItem,
  ExternalIdResult,
} from '../interfaces/metadata-provider.interface';
import type {
  TvdbResponse,
  TvdbLoginResponse,
  TvdbSearchResult,
  TvdbMovieExtended,
  TvdbSeriesExtended,
  TvdbSeasonExtended,
  TvdbEpisodeBase,
  TvdbPeopleExtended,
  TvdbSearchByRemoteId,
  TvdbSeriesEpisodes,
  TvdbCharacter,
  TvdbArtwork,
  TvdbRemoteId,
  TvdbTranslation,
  TvdbSeasonBase,
  TvdbAlias,
} from './tvdb-api.types';
import {
  MetadataSettingsCache,
  MetadataLanguageOverride,
} from '../metadata-settings-cache.service';

const TVDB_BASE = 'https://api4.thetvdb.com/v4';

/**
 * Collect TVDB aliases into the same flat string array shape that the TMDB
 * provider produces. Deduplicates against the canonical name and lowercase
 * variants so we don't pad the field with redundant entries.
 */
function dedupeAliases(
  aliases: TvdbAlias[] | undefined,
  canonical: string,
): string[] {
  if (!aliases?.length) return [];
  const seen = new Set<string>([canonical.toLowerCase()]);
  const out: string[] = [];
  for (const a of aliases) {
    const t = (a.name ?? '').trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/** Artwork type IDs: 2=poster, 3=background/fanart, 7=banner, 12=clearart */
const ART_POSTER = 2;
const ART_BACKGROUND = 3;
// TVDB clearlogo artwork type — distinct id per record kind (series vs movie).
const ART_CLEARLOGO_SERIES = 23;
const ART_CLEARLOGO_MOVIE = 25;

@Injectable()
export class TvdbProvider implements IMetadataProvider {
  readonly name = 'tvdb';
  readonly supportsPersonLookup = true;
  private readonly logger = new Logger(TvdbProvider.name);
  private client: AxiosInstance;
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly metaLang: MetadataSettingsCache,
  ) {
    this.client = axios.create({ baseURL: TVDB_BASE, timeout: 15000 });
  }

  // ── Auth ──

  private async ensureAuth(): Promise<void> {
    if (this.token && Date.now() < this.tokenExpiresAt) return;
    const apiKey = this.config.get<string>('TVDB_API_KEY', '');
    if (!apiKey) throw new Error('TVDB API key not configured');

    const { data } = await axios.post<TvdbResponse<TvdbLoginResponse>>(
      `${TVDB_BASE}/login`,
      { apikey: apiKey },
    );
    this.token = data.data.token;
    // Token valid 30 days, refresh after 25 days
    this.tokenExpiresAt = Date.now() + 25 * 24 * 60 * 60 * 1000;
    this.client = axios.create({
      baseURL: TVDB_BASE,
      timeout: 15000,
      headers: { Authorization: `Bearer ${this.token}` },
    });
  }

  // ── Search ──

  async searchMovie(
    query: string,
    year?: number,
  ): Promise<MetadataSearchResult[]> {
    await this.ensureAuth();
    const tvdb = (await this.metaLang.resolve()).tvdbCode;
    const params: Record<string, string> = { q: query, type: 'movie' };
    if (year) params.year = String(year);

    const { data } = await this.client.get<TvdbResponse<TvdbSearchResult[]>>(
      '/search',
      { params },
    );
    return (data.data ?? []).map((r) => this.mapSearchResult(r, 'movie', tvdb));
  }

  async searchTvShow(
    query: string,
    year?: number,
  ): Promise<MetadataSearchResult[]> {
    await this.ensureAuth();
    const tvdb = (await this.metaLang.resolve()).tvdbCode;
    const params: Record<string, string> = { q: query, type: 'series' };
    if (year) params.year = String(year);

    const { data } = await this.client.get<TvdbResponse<TvdbSearchResult[]>>(
      '/search',
      { params },
    );
    return (data.data ?? []).map((r) => this.mapSearchResult(r, 'series', tvdb));
  }

  // ── Movie details ──

  async getMovieDetails(
    externalId: string,
    override?: MetadataLanguageOverride,
  ): Promise<MetadataDetails> {
    await this.ensureAuth();
    const tvdb = (await this.metaLang.resolve(override)).tvdbCode;
    const id = parseInt(externalId, 10);
    const { data } = await this.client.get<TvdbResponse<TvdbMovieExtended>>(
      `/movies/${id}/extended`,
      { params: { meta: 'translations' } },
    );
    const m = data.data;
    const localized = this.pickTranslation(m.translations, tvdb);
    const imdbId = this.extractRemoteId(m.remoteIds, 'IMDB');

    return {
      seasonCount: null,
      episodeCount: null,
      tmdbId: parseInt(
        this.extractRemoteId(m.remoteIds, 'TheMovieDB.com') ?? '0',
        10,
      ),
      tvdbId: m.id,
      imdbId,
      provider: 'tvdb',
      title: localized?.name ?? m.name,
      originalTitle: m.name,
      overview: localized?.overview ?? '',
      year: m.year ? parseInt(m.year) : null,
      posterUrl:
        this.pickArtwork(m.artworks, ART_POSTER, tvdb) ?? m.image ?? null,
      fanartUrl: this.pickArtwork(m.artworks, ART_BACKGROUND, tvdb) ?? null,
      logoUrl: this.pickArtwork(m.artworks, ART_CLEARLOGO_MOVIE, tvdb) ?? null,
      additionalFanartUrls: this.pickArtworks(
        m.artworks,
        ART_BACKGROUND,
        5,
        this.pickArtwork(m.artworks, ART_BACKGROUND, tvdb),
      ),
      rating: 0,
      genres: (m.genres ?? []).map((g) => g.name),
      mediaType: 'movie',
      runtime: m.runtime ?? null,
      releaseDate: m.first_release?.date ?? null,
      inCinemas:
        this.pickReleaseDate(m.releases, 'Theatrical') ??
        m.first_release?.date ??
        null,
      digitalRelease: this.pickReleaseDate(m.releases, 'Digital'),
      physicalRelease: this.pickReleaseDate(m.releases, 'Physical'),
      status: m.status?.name?.toLowerCase() ?? 'unknown',
      budget: m.budget ? parseInt(m.budget) || null : null,
      revenue: m.boxOffice ? parseInt(m.boxOffice) || null : null,
      originalLanguage: m.originalLanguage ?? null,
      productionCountries: (m.production_countries ?? []).map((c) => c.name),
      productionCompanies: [
        ...(m.companies?.production ?? []).map((c) => c.name),
        ...(m.companies?.studio ?? []).map((c) => c.name),
      ],
      voteCount: null,
      popularity: null,
      tagline: localized?.tagline ?? null,
      cast: this.mapCast(m.characters),
      crew: this.mapCrew(m.characters),
      videos: (m.trailers ?? []).map((t) => ({
        key: this.extractVideoKey(t.url),
        site: t.url?.includes('youtube') ? 'YouTube' : 'Unknown',
        type: 'Trailer',
        name: t.name,
      })),
      keywords: (m.tagOptions ?? []).map((t) => t.name),
      alternativeTitles: dedupeAliases(m.aliases, m.name),
      tmdbCollectionId: null,
      tmdbCollectionName: null,
    };
  }

  // ── Series details ──

  async getTvShowDetails(
    externalId: string,
    override?: MetadataLanguageOverride,
  ): Promise<MetadataDetails> {
    await this.ensureAuth();
    const tvdb = (await this.metaLang.resolve(override)).tvdbCode;
    const id = parseInt(externalId, 10);
    const { data } = await this.client.get<TvdbResponse<TvdbSeriesExtended>>(
      `/series/${id}/extended`,
      { params: { meta: 'translations' } },
    );
    const s = data.data;
    const localized = this.pickTranslation(s.translations, tvdb);
    const imdbId = this.extractRemoteId(s.remoteIds, 'IMDB');

    return {
      seasonCount: (s.seasons ?? []).filter((x: { number?: number }) => x.number !== 0).length || null,
      episodeCount: null,
      tmdbId: parseInt(
        this.extractRemoteId(s.remoteIds, 'TheMovieDB.com') ?? '0',
        10,
      ),
      tvdbId: s.id,
      imdbId,
      provider: 'tvdb',
      title: localized?.name ?? s.name,
      originalTitle: s.name,
      overview: localized?.overview ?? '',
      year: s.year ? parseInt(s.year) : null,
      posterUrl:
        this.pickArtwork(s.artworks, ART_POSTER, tvdb) ?? s.image ?? null,
      fanartUrl: this.pickArtwork(s.artworks, ART_BACKGROUND, tvdb) ?? null,
      logoUrl: this.pickArtwork(s.artworks, ART_CLEARLOGO_SERIES, tvdb) ?? null,
      additionalFanartUrls: this.pickArtworks(
        s.artworks,
        ART_BACKGROUND,
        5,
        this.pickArtwork(s.artworks, ART_BACKGROUND, tvdb),
      ),
      rating: 0,
      genres: (s.genres ?? []).map((g) => g.name),
      mediaType: 'series',
      runtime: null,
      releaseDate: s.firstAired ?? null,
      inCinemas: null,
      digitalRelease: null,
      physicalRelease: null,
      status: this.mapSeriesStatus(s.status?.name ?? ''),
      budget: null,
      revenue: null,
      originalLanguage: s.originalLanguage ?? null,
      productionCountries: s.originalCountry ? [s.originalCountry] : [],
      productionCompanies: [
        ...(s.networks ?? []).map((n) => n.name),
        ...(s.companies?.production ?? []).map((c) => c.name),
        ...(s.studios ?? []).map((c) => c.name),
      ],
      voteCount: null,
      popularity: null,
      tagline: localized?.tagline ?? null,
      cast: this.mapCast(s.characters),
      crew: this.mapCrew(s.characters),
      videos: (s.trailers ?? []).map((t) => ({
        key: this.extractVideoKey(t.url),
        site: t.url?.includes('youtube') ? 'YouTube' : 'Unknown',
        type: 'Trailer',
        name: t.name,
      })),
      keywords: (s.tagOptions ?? []).map((t) => t.name),
      alternativeTitles: dedupeAliases(s.aliases, s.name),
      tmdbCollectionId: null,
      tmdbCollectionName: null,
    };
  }

  // ── Seasons ──

  async getTvShowSeasons(
    externalId: string,
    override?: MetadataLanguageOverride,
  ): Promise<SeasonDetails[]> {
    await this.ensureAuth();
    const tvdb = (await this.metaLang.resolve(override)).tvdbCode;
    const id = parseInt(externalId, 10);

    // Fetch all episodes (paginated) via the default season type
    const allEpisodes: TvdbEpisodeBase[] = [];
    let page = 0;
    let hasMore = true;
    while (hasMore) {
      const { data } = await this.client.get<TvdbResponse<TvdbSeriesEpisodes>>(
        `/series/${id}/episodes/default`,
        { params: { page: String(page) } },
      );
      const eps = data.data?.episodes ?? [];
      allEpisodes.push(...eps);
      hasMore = eps.length >= 500; // TVDB paginates at 500
      page++;
    }

    // Also fetch season list for metadata
    const { data: seriesData } = await this.client.get<
      TvdbResponse<TvdbSeriesExtended>
    >(`/series/${id}/extended`, { params: { short: 'true' } });
    const seasonBases: TvdbSeasonBase[] = (
      seriesData.data?.seasons ?? []
    ).filter(
      (s) => s.type?.type === 'official' || s.type?.name === 'Aired Order',
    );

    // Fetch localized translations for each episode that advertises them
    const epTranslations = new Map<
      number,
      { name?: string; overview?: string }
    >();
    for (const ep of allEpisodes) {
      if (
        ep.overviewTranslations?.includes(tvdb) ||
        ep.nameTranslations?.includes(tvdb)
      ) {
        try {
          const { data: trData } = await this.client.get<
            TvdbResponse<{ name: string; overview: string }>
          >(`/episodes/${ep.id}/translations/${tvdb}`);
          epTranslations.set(ep.id, trData.data);
        } catch {
          /* translation not available */
        }
      }
    }

    // Group episodes by season
    const seasonMap = new Map<number, TvdbEpisodeBase[]>();
    for (const ep of allEpisodes) {
      if (ep.seasonNumber === 0) continue; // skip specials
      const list = seasonMap.get(ep.seasonNumber) ?? [];
      list.push(ep);
      seasonMap.set(ep.seasonNumber, list);
    }

    const seasons: SeasonDetails[] = [];
    for (const [seasonNumber, eps] of seasonMap.entries()) {
      const seasonBase = seasonBases.find((s) => s.number === seasonNumber);
      eps.sort((a, b) => a.number - b.number);

      seasons.push({
        seasonNumber,
        episodeCount: eps.length,
        overview: null,
        airDate: seasonBase?.year ?? eps[0]?.aired ?? null,
        posterUrl: seasonBase?.image || null,
        episodes: eps.map((ep) => {
          const tr = epTranslations.get(ep.id);
          return {
            episodeNumber: ep.number,
            title: tr?.name ?? ep.name,
            overview: tr?.overview ?? ep.overview ?? null,
            airDate: ep.aired ?? null,
            runtime: ep.runtime ?? null,
            stillUrl: ep.image ?? null,
          };
        }),
      });
    }

    seasons.sort((a, b) => a.seasonNumber - b.seasonNumber);
    return seasons;
  }

  // ── People ──

  async getPersonDetails(externalId: string): Promise<PersonDetails> {
    await this.ensureAuth();
    const tvdb = (await this.metaLang.resolve()).tvdbCode;
    const id = parseInt(externalId, 10);
    const { data } = await this.client.get<TvdbResponse<TvdbPeopleExtended>>(
      `/people/${id}/extended`,
      { params: { meta: 'translations' } },
    );
    const p = data.data;
    const bio =
      p.biographies?.find((b) => b.language === tvdb)?.biography ??
      p.biographies?.find((b) => b.language === 'eng')?.biography ??
      '';

    return {
      externalId: p.id,
      name: p.name,
      biography: bio,
      birthday: p.birth ?? null,
      deathday: p.death ?? null,
      placeOfBirth: p.birthPlace ?? null,
      avatarUrl: p.image ?? null,
      knownForDepartment: this.inferDepartment(p.characters),
    };
  }

  async getPersonCredits(externalId: string): Promise<PersonCombinedCredits> {
    await this.ensureAuth();
    const id = parseInt(externalId, 10);
    const { data } = await this.client.get<TvdbResponse<TvdbPeopleExtended>>(
      `/people/${id}/extended`,
    );
    const chars = data.data?.characters ?? [];

    const cast: PersonCreditItem[] = chars
      .filter((c) => c.peopleType === 'Actor' || c.peopleType === 'Guest Star')
      .map((c) => ({
        externalId: c.seriesId ?? c.movieId ?? 0,
        title: '',
        mediaType: c.movieId ? 'movie' : 'series',
        character: c.name,
        posterUrl: c.image ?? null,
        releaseDate: null,
        rating: 0,
      }));

    const crew: PersonCreditItem[] = chars
      .filter((c) => c.peopleType !== 'Actor' && c.peopleType !== 'Guest Star')
      .map((c) => ({
        externalId: c.seriesId ?? c.movieId ?? 0,
        title: '',
        mediaType: c.movieId ? 'movie' : 'series',
        job: c.peopleType,
        department: c.peopleType,
        posterUrl: c.image ?? null,
        releaseDate: null,
        rating: 0,
      }));

    return { cast, crew };
  }

  // ── Cross-reference ──

  async findByExternalId(
    source: string,
    id: string,
    _override?: MetadataLanguageOverride,
  ): Promise<ExternalIdResult | null> {
    await this.ensureAuth();
    try {
      const { data } = await this.client.get<
        TvdbResponse<TvdbSearchByRemoteId[]>
      >(`/search/remoteid/${id}`);
      const results = data.data ?? [];
      for (const r of results) {
        if (r.series) return { id: String(r.series.id), mediaType: 'series' };
        if (r.movie) return { id: String(r.movie.id), mediaType: 'movie' };
      }
    } catch {
      // Remote ID not found
    }
    return null;
  }

  // ── Helpers ──

  private mapSearchResult(
    r: TvdbSearchResult,
    mediaType: 'movie' | 'series',
    tvdb: string,
  ): MetadataSearchResult {
    const imdbId =
      r.remote_ids?.find((rid) => rid.sourceName === 'IMDB')?.id ?? null;
    return {
      tmdbId: parseInt(
        r.remote_ids?.find((rid) => rid.sourceName === 'TheMovieDB.com')?.id ??
          '0',
        10,
      ),
      tvdbId: parseInt(r.tvdb_id ?? r.id, 10),
      imdbId,
      provider: 'tvdb',
      title: r.translations?.[tvdb] ?? r.name,
      originalTitle: r.name,
      overview: r.overviews?.[tvdb] ?? r.overview ?? '',
      year: r.year ? parseInt(r.year) : null,
      posterUrl: r.image_url ?? r.poster ?? null,
      rating: 0,
      genres: r.genres ?? [],
      mediaType,
    };
  }

  private mapCast(
    characters: TvdbCharacter[] | undefined,
  ): MetadataDetails['cast'] {
    if (!characters) return [];
    return characters
      .filter((c) => c.peopleType === 'Actor' || c.peopleType === 'Guest Star')
      .sort((a, b) => (a.sort ?? 999) - (b.sort ?? 999))
      .map((c, i) => ({
        externalId: c.peopleId,
        name: c.personName,
        character: c.name,
        avatarUrl: c.personImgURL ?? null,
        order: c.sort ?? i,
      }));
  }

  private mapCrew(
    characters: TvdbCharacter[] | undefined,
  ): MetadataDetails['crew'] {
    if (!characters) return [];
    return characters
      .filter(
        (c) =>
          c.peopleType !== 'Actor' &&
          c.peopleType !== 'Guest Star' &&
          c.peopleType,
      )
      .map((c) => ({
        externalId: c.peopleId,
        name: c.personName,
        job: c.peopleType,
        department: c.peopleType,
        avatarUrl: c.personImgURL ?? null,
      }));
  }

  private pickTranslation(
    translations:
      | {
          nameTranslations?: TvdbTranslation[];
          overviewTranslations?: TvdbTranslation[];
        }
      | undefined,
    lang: string,
  ): { name?: string; overview?: string; tagline?: string } | null {
    if (!translations) return null;
    const name = translations.nameTranslations?.find(
      (t) => t.language === lang,
    );
    const overview = translations.overviewTranslations?.find(
      (t) => t.language === lang,
    );
    if (!name && !overview) return null;
    return {
      name: name?.name,
      overview: overview?.overview,
      tagline: name?.tagline ?? overview?.tagline,
    };
  }

  private pickArtwork(
    artworks: TvdbArtwork[] | undefined,
    type: number,
    lang: string,
  ): string | null {
    if (!artworks) return null;
    // Prefer the configured language, then any, sorted by score
    const filtered = artworks
      .filter((a) => a.type === type)
      .sort((a, b) => {
        if (a.language === lang && b.language !== lang) return -1;
        if (b.language === lang && a.language !== lang) return 1;
        return (b.score ?? 0) - (a.score ?? 0);
      });
    return filtered[0]?.image ?? null;
  }

  /** Top-N artworks of a given type, skipping the one already
   *  consumed as the primary (matched by URL). Sorted by score
   *  descending — same ranking as {@link pickArtwork}. */
  private pickArtworks(
    artworks: TvdbArtwork[] | undefined,
    type: number,
    n: number,
    skipUrl: string | null,
  ): string[] {
    if (!artworks) return [];
    return artworks
      .filter((a) => a.type === type && a.image && a.image !== skipUrl)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, n)
      .map((a) => a.image);
  }

  private extractRemoteId(
    remoteIds: TvdbRemoteId[] | undefined,
    source: string,
  ): string | null {
    return remoteIds?.find((r) => r.sourceName === source)?.id ?? null;
  }

  private extractVideoKey(url: string): string {
    if (!url) return '';
    const match = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    return match?.[1] ?? url;
  }

  private pickReleaseDate(
    releases: { country: string; date: string; detail: string }[] | undefined,
    type: string,
  ): string | null {
    if (!releases) return null;
    const match = releases.find((r) =>
      r.detail?.toLowerCase().includes(type.toLowerCase()),
    );
    return match?.date ?? null;
  }

  private mapSeriesStatus(status: string): string {
    const map: Record<string, string> = {
      Continuing: 'continuing',
      Ended: 'ended',
      Upcoming: 'announced',
    };
    return map[status] ?? 'unknown';
  }

  private inferDepartment(characters: TvdbCharacter[] | undefined): string {
    if (!characters?.length) return 'Acting';
    const types = characters.map((c) => c.peopleType);
    if (types.includes('Actor')) return 'Acting';
    if (types.includes('Director')) return 'Directing';
    if (types.includes('Writer')) return 'Writing';
    return types[0] ?? 'Acting';
  }
}
