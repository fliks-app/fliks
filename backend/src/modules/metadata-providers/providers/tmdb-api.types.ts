/** Narrow shapes for TMDB JSON used by TmdbProvider (not full API schemas). */

export interface TmdbNamed {
  name: string;
}

export interface TmdbMovieListItem {
  id: number;
  title: string;
  original_title: string;
  overview: string;
  release_date?: string;
  poster_path?: string | null;
  vote_average?: number;
}

export interface TmdbTvListItem {
  id: number;
  name: string;
  original_name: string;
  overview: string;
  first_air_date?: string;
  poster_path?: string | null;
  vote_average?: number;
}

export interface TmdbPaginated<T> {
  results: T[];
}

export interface TmdbReleaseDateCountry {
  iso_3166_1: string;
  release_dates: { type: number; release_date: string }[];
}

export interface TmdbMovieDetailsResponse {
  id: number;
  title: string;
  original_title: string;
  overview: string;
  release_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  genres?: TmdbNamed[];
  runtime?: number;
  status?: string;
  budget?: number;
  revenue?: number;
  original_language?: string;
  production_countries?: { name: string }[];
  production_companies?: { name: string }[];
  vote_count?: number;
  popularity?: number;
  external_ids?: { imdb_id?: string | null };
  imdb_id?: string;
  release_dates?: { results?: TmdbReleaseDateCountry[] };
}

export interface TmdbTvDetailsResponse {
  id: number;
  name: string;
  original_name: string;
  overview: string;
  first_air_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  genres?: TmdbNamed[];
  external_ids?: { imdb_id?: string | null };
  episode_run_time?: number[];
  status?: string;
  original_language?: string;
  origin_country?: string[];
  networks?: { name: string }[];
  production_companies?: { name: string }[];
  vote_count?: number;
  popularity?: number;
}

export interface TmdbTvSeasonStub {
  season_number: number;
  episode_count?: number;
}

export interface TmdbTvShowWithSeasons {
  seasons?: TmdbTvSeasonStub[];
}

export interface TmdbTvEpisode {
  episode_number: number;
  name: string;
  overview?: string | null;
  air_date?: string | null;
  runtime?: number | null;
  still_path?: string | null;
}

export interface TmdbTvSeasonResponse {
  season_number: number;
  overview?: string | null;
  air_date?: string | null;
  episodes?: TmdbTvEpisode[];
}
