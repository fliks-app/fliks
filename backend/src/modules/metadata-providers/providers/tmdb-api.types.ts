/** Narrow shapes for TMDB JSON used by TmdbProvider (not full API schemas). */

export interface TmdbNamed {
  name: string;
}

export interface TmdbCastMember {
  id: number;
  name: string;
  character: string;
  profile_path?: string | null;
  order: number;
}

export interface TmdbCrewMember {
  id: number;
  name: string;
  job: string;
  department: string;
  profile_path?: string | null;
}

export interface TmdbVideo {
  key: string;
  site: string;
  type: string;
  name: string;
  official: boolean;
}

export interface TmdbKeyword {
  id: number;
  name: string;
}

export interface TmdbPersonDetailsResponse {
  id: number;
  name: string;
  biography: string;
  birthday?: string | null;
  deathday?: string | null;
  place_of_birth?: string | null;
  profile_path?: string | null;
  known_for_department: string;
}

export interface TmdbPersonCreditItem {
  id: number;
  title?: string;
  name?: string;
  media_type: 'movie' | 'tv';
  character?: string;
  job?: string;
  department?: string;
  poster_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
}

export interface TmdbPersonCombinedCreditsResponse {
  cast: TmdbPersonCreditItem[];
  crew: TmdbPersonCreditItem[];
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

export interface TmdbImage {
  file_path: string;
  vote_average?: number;
  iso_639_1?: string | null;
  width?: number;
  height?: number;
}

export interface TmdbImages {
  backdrops?: TmdbImage[];
  posters?: TmdbImage[];
  logos?: TmdbImage[];
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
  belongs_to_collection?: { id: number; name: string } | null;
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
  tagline?: string;
  external_ids?: { imdb_id?: string | null };
  imdb_id?: string;
  release_dates?: { results?: TmdbReleaseDateCountry[] };
  credits?: { cast?: TmdbCastMember[]; crew?: TmdbCrewMember[] };
  videos?: { results?: TmdbVideo[] };
  keywords?: { keywords?: TmdbKeyword[] };
  alternative_titles?: {
    titles?: { iso_3166_1?: string; title: string; type?: string }[];
  };
  images?: TmdbImages;
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
  tagline?: string;
  vote_count?: number;
  popularity?: number;
  credits?: { cast?: TmdbCastMember[]; crew?: TmdbCrewMember[] };
  videos?: { results?: TmdbVideo[] };
  keywords?: { results?: TmdbKeyword[] };
  alternative_titles?: {
    results?: { iso_3166_1?: string; title: string; type?: string }[];
  };
  images?: TmdbImages;
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
  poster_path?: string | null;
  episodes?: TmdbTvEpisode[];
}
