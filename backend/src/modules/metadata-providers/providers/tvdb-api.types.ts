/** TVDB API v4 response wrapper */
export interface TvdbResponse<T> {
  data: T;
  status: string;
}

/** POST /login response */
export interface TvdbLoginResponse {
  token: string;
}

/** GET /search result item */
export interface TvdbSearchResult {
  id: string;
  name: string;
  type: string;
  year: string;
  overview: string;
  image_url: string;
  poster: string;
  slug: string;
  status: string;
  first_air_time: string;
  primary_language: string;
  genres: string[];
  remote_ids: TvdbRemoteId[];
  tvdb_id: string;
  translations?: Record<string, string>;
  overviews?: Record<string, string>;
}

/** GET /movies/{id}/extended */
export interface TvdbMovieExtended {
  id: number;
  name: string;
  slug: string;
  image: string;
  year: string;
  runtime: number | null;
  score: number;
  status: TvdbStatus;
  aliases: TvdbAlias[];
  artworks: TvdbArtwork[];
  characters: TvdbCharacter[];
  companies: TvdbCompanies;
  genres: TvdbGenre[];
  nameTranslations: string[];
  overviewTranslations: string[];
  originalCountry: string;
  originalLanguage: string;
  production_countries: { id: number; country: string; name: string }[];
  remoteIds: TvdbRemoteId[];
  trailers: TvdbTrailer[];
  translations?: TvdbTranslationExtended;
  budget?: string;
  boxOffice?: string;
  first_release?: { country: string; date: string; detail: string };
  releases?: { country: string; date: string; detail: string }[];
  tagOptions?: TvdbTagOption[];
}

/** GET /series/{id}/extended */
export interface TvdbSeriesExtended {
  id: number;
  name: string;
  slug: string;
  image: string;
  score: number;
  status: TvdbStatus;
  aliases: TvdbAlias[];
  artworks: TvdbArtwork[];
  characters: TvdbCharacter[];
  companies: TvdbCompanies;
  firstAired: string;
  lastAired: string;
  genres: TvdbGenre[];
  nameTranslations: string[];
  overviewTranslations: string[];
  originalCountry: string;
  originalLanguage: string;
  remoteIds: TvdbRemoteId[];
  seasons: TvdbSeasonBase[];
  trailers: TvdbTrailer[];
  translations?: TvdbTranslationExtended;
  year: string;
  networks?: TvdbCompanyBase[];
  studios?: TvdbCompanyBase[];
  tagOptions?: TvdbTagOption[];
}

/** GET /seasons/{id}/extended */
export interface TvdbSeasonExtended {
  id: number;
  name: string;
  number: number;
  image: string;
  year: string;
  seriesId: number;
  type: TvdbSeasonType;
  episodes?: TvdbEpisodeBase[];
  nameTranslations: string[];
  overviewTranslations: string[];
}

/** Episode base record (returned in season episodes listing) */
export interface TvdbEpisodeBase {
  id: number;
  name: string;
  number: number;
  seasonNumber: number;
  absoluteNumber: number;
  aired: string;
  year: string;
  image: string;
  imageType: number | null;
  runtime: number | null;
  overview: string;
  seriesId: number;
  finaleType: string;
  nameTranslations: string[];
  overviewTranslations: string[];
}

/** GET /episodes/{id}/extended */
export interface TvdbEpisodeExtended extends TvdbEpisodeBase {
  characters: TvdbCharacter[];
  remoteIds: TvdbRemoteId[];
  trailers: TvdbTrailer[];
  translations?: TvdbTranslationExtended;
}

/** GET /people/{id}/extended */
export interface TvdbPeopleExtended {
  id: number;
  name: string;
  image: string;
  score: number;
  slug: string;
  birth: string;
  death: string;
  birthPlace: string;
  gender: number;
  aliases: TvdbAlias[];
  biographies: TvdbBiography[];
  characters: TvdbCharacter[];
  nameTranslations: string[];
  overviewTranslations: string[];
  remoteIds: TvdbRemoteId[];
  translations?: TvdbTranslationExtended;
}

/** GET /search/remoteid/{id} */
export interface TvdbSearchByRemoteId {
  series?: TvdbSeriesBase;
  movie?: TvdbMovieBase;
  people?: TvdbPeopleBase;
  episode?: TvdbEpisodeBase;
}

/** Series episodes listing (paginated) */
export interface TvdbSeriesEpisodes {
  series: TvdbSeriesBase;
  episodes: TvdbEpisodeBase[];
}

// ── Supporting types ──

export interface TvdbStatus {
  id: number;
  name: string;
  recordType: string;
  keepUpdated: boolean;
}

export interface TvdbAlias {
  language: string;
  name: string;
}

export interface TvdbArtwork {
  id: number;
  type: number;
  language: string;
  image: string;
  thumbnail: string;
  width: number;
  height: number;
  score: number;
  includesText: boolean;
}

export interface TvdbCharacter {
  id: number;
  name: string;
  seriesId: number | null;
  episodeId: number | null;
  movieId: number | null;
  peopleId: number;
  personName: string;
  personImgURL: string;
  image: string;
  isFeatured: boolean;
  sort: number;
  type: number;
  url: string;
  peopleType: string;
}

export interface TvdbGenre {
  id: number;
  name: string;
  slug: string;
}

export interface TvdbRemoteId {
  id: string;
  type: number;
  sourceName: string;
}

export interface TvdbTrailer {
  id: number;
  name: string;
  url: string;
  language: string;
  runtime: number;
}

export interface TvdbCompanies {
  studio?: TvdbCompanyBase[];
  network?: TvdbCompanyBase[];
  production?: TvdbCompanyBase[];
  distributor?: TvdbCompanyBase[];
  special_effects?: TvdbCompanyBase[];
}

export interface TvdbCompanyBase {
  id: number;
  name: string;
  slug: string;
  country: string;
}

export interface TvdbSeasonBase {
  id: number;
  number: number;
  seriesId: number;
  name: string;
  image: string;
  type: TvdbSeasonType;
  year: string;
}

export interface TvdbSeasonType {
  id: number;
  name: string;
  type: string;
  alternateName: string;
}

export interface TvdbTranslationExtended {
  nameTranslations: TvdbTranslation[];
  overviewTranslations: TvdbTranslation[];
  aliases: string[] | null;
}

export interface TvdbTranslation {
  language: string;
  name?: string;
  overview?: string;
  tagline?: string;
  isPrimary?: boolean;
}

export interface TvdbBiography {
  biography: string;
  language: string;
}

export interface TvdbTagOption {
  id: number;
  tag: number;
  tagName: string;
  name: string;
  helpText: string;
}

export interface TvdbSeriesBase {
  id: number;
  name: string;
  slug: string;
  image: string;
  score: number;
  status: TvdbStatus;
  firstAired: string;
  lastAired: string;
  year: string;
  originalCountry: string;
  originalLanguage: string;
}

export interface TvdbMovieBase {
  id: number;
  name: string;
  slug: string;
  image: string;
  score: number;
  status: TvdbStatus;
  year: string;
  runtime: number | null;
  originalCountry: string;
  originalLanguage: string;
}

export interface TvdbPeopleBase {
  id: number;
  name: string;
  image: string;
  score: number;
  slug: string;
}
