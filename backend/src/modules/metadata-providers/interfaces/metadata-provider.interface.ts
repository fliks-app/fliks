export interface MetadataSearchResult {
  tmdbId: number;
  title: string;
  originalTitle: string;
  overview: string;
  year: number | null;
  posterUrl: string | null;
  rating: number;
  genres: string[];
  mediaType: 'movie' | 'series';
}

export interface MetadataDetails extends MetadataSearchResult {
  imdbId: string | null;
  fanartUrl: string | null;
  runtime: number | null;
  releaseDate: string | null;
  inCinemas: string | null;
  digitalRelease: string | null;
  physicalRelease: string | null;
  status: string;
  budget: number | null;
  revenue: number | null;
  originalLanguage: string | null;
  productionCountries: string[];
  productionCompanies: string[];
  voteCount: number | null;
  popularity: number | null;
}

export interface SeasonDetails {
  seasonNumber: number;
  episodeCount: number;
  overview: string | null;
  airDate: string | null;
  episodes: EpisodeDetails[];
}

export interface EpisodeDetails {
  episodeNumber: number;
  title: string;
  overview: string | null;
  airDate: string | null;
  runtime: number | null;
  stillUrl: string | null;
}

export interface IMetadataProvider {
  readonly name: string;

  searchMovie(query: string, year?: number): Promise<MetadataSearchResult[]>;
  searchTvShow(query: string, year?: number): Promise<MetadataSearchResult[]>;
  getMovieDetails(tmdbId: number): Promise<MetadataDetails>;
  getTvShowDetails(tmdbId: number): Promise<MetadataDetails>;
  getTvShowSeasons(tmdbId: number): Promise<SeasonDetails[]>;
}
