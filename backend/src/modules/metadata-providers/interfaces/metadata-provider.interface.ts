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
  tagline: string | null;
  cast: MetadataCastItem[];
  crew: MetadataCrewItem[];
  videos: MetadataVideo[];
  keywords: string[];
}

export interface MetadataCastItem {
  externalId: number;
  name: string;
  character: string;
  avatarUrl: string | null;
  order: number;
}

export interface MetadataCrewItem {
  externalId: number;
  name: string;
  job: string;
  department: string;
  avatarUrl: string | null;
}

export interface MetadataVideo {
  key: string;
  site: string;
  type: string;
  name: string;
}

export interface PersonDetails {
  externalId: number;
  name: string;
  biography: string;
  birthday: string | null;
  deathday: string | null;
  placeOfBirth: string | null;
  avatarUrl: string | null;
  knownForDepartment: string;
}

export interface PersonCreditItem {
  externalId: number;
  title: string;
  mediaType: 'movie' | 'series';
  character?: string;
  job?: string;
  department?: string;
  posterUrl: string | null;
  releaseDate: string | null;
  rating: number;
}

export interface PersonCombinedCredits {
  cast: PersonCreditItem[];
  crew: PersonCreditItem[];
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
  getPersonDetails(externalId: number): Promise<PersonDetails>;
  getPersonCredits(externalId: number): Promise<PersonCombinedCredits>;
}
