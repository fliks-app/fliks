// Wire contract: the F4 section of the music plan (tracks are named by `itemId`)

export interface MusicPerson {
  id: number;
  name: string;
  sortName: string | null;
  avatarUrl: string | null;
}

export interface AlbumArtist {
  id: number;
  name: string;
  sortName: string | null;
  creditedName: string | null;
  joinPhrase: string | null;
}

// GET /api/media?type=album list items carry `album`
export interface AlbumListInfo {
  artists: MusicPerson[];
  primaryType: string | null;
  secondaryTypes: string[];
  firstReleaseDate: string | null;
  isCompilation: boolean;
  trackCount: number;
  discCount: number;
  durationSeconds: number;
  playCount: number;
}

export interface AlbumEdition {
  id: number;
  title: string | null;
  country: string | null;
  status: string | null;
  media: string | null;
  barcode: string | null;
  catalogNumber: string | null;
  label: string | null;
  releaseDate: string | null;
  trackCount: number;
  discCount: number;
  albumGain: number | null;
  albumPeak: number | null;
  coverUrl: string | null;
  libraryId: number | null;
  hasFiles: boolean;
  orphaned: boolean;
}

export interface TrackArtist {
  id: number | null;
  name: string;
  creditedName: string | null;
  joinPhrase: string | null;
}

export type TrackCreditRole = 'composer' | 'lyricist' | 'performer' | 'conductor' | 'orchestra' | 'ensemble';

export interface TrackCredit {
  personId: number;
  name: string;
  role: TrackCreditRole;
  instrument: string | null;
}

export interface TrackWork {
  workId: number;
  title: string;
  parentWorkId: number | null;
  composerPersonId: number | null;
  composerName: string | null;
  position: number;
}

export interface Track {
  itemId: number;
  editionId: number;
  /** The playable part's file; null when the track has none. */
  mediaFileId: number | null;
  hasFile: boolean;
  orphaned: boolean;
  discNumber: number;
  discTitle: string | null;
  position: number;
  trackNumber: number | null;
  label: string | null;
  title: string;
  durationSeconds: number | null;
  explicit: boolean;
  gain: number | null;
  peak: number | null;
  artists: TrackArtist[];
  credits: TrackCredit[];
  works: TrackWork[];
  favourite: boolean;
  playCount: number;
  lastPlayedAt: string | null;
}

// GET /api/media/:id of an album carries `album`
export interface AlbumDetail {
  primaryType: string | null;
  secondaryTypes: string[];
  firstReleaseDate: string | null;
  isCompilation: boolean;
  targetEditionId: number | null;
  orphaned: boolean;
  artists: AlbumArtist[];
  editions: AlbumEdition[];
  /** Every edition's tracks, by edition, disc number, position. */
  tracks: Track[];
}

// GET /api/tracks
export interface TrackRow extends Track {
  mediaId: number;
  albumTitle: string;
  posterUrl: string | null;
}

export interface TracksQuery {
  libraryId?: number;
  q?: string;
  favourite?: boolean;
  sortBy?: 'title' | 'album' | 'added' | 'played';
  sortOrder?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

export interface ArtistAlbum {
  /** Null: the album is in the provider's discography and not in the library. */
  mediaId: number | null;
  externalId: string | null;
  title: string;
  year: number | null;
  primaryType: string | null;
  secondaryTypes: string[];
  posterUrl: string | null;
  owned: boolean;
  monitored: boolean;
  trackCount: number;
  ownedTrackCount: number;
}

// GET /api/persons/:id/discography
export interface Discography {
  artist: {
    id: number;
    name: string;
    sortName: string | null;
    disambiguation: string | null;
    artistType: string | null;
    biography: string | null;
    imageUrl: string | null;
    following: boolean;
  };
  albums: ArtistAlbum[];
}

// GET /api/persons?role=artist|composer
export interface MusicPersonRow extends MusicPerson {
  albumCount: number;
  trackCount: number;
}

// GET /api/composers/:id/works
export interface ComposerWork {
  workId: number;
  title: string;
  children: { workId: number; title: string }[];
  recordingCount: number;
}

// GET /api/works/:id/recordings
export interface WorkRecording {
  itemId: number;
  mediaId: number;
  albumTitle: string;
  posterUrl: string | null;
  title: string;
  performers: { id: number; name: string; role: string }[];
  year: number | null;
  durationSeconds: number | null;
  mediaFileId: number | null;
}

// GET /api/media/:id/music/candidates
export interface AlbumCandidate {
  /** Release-group id and release id at the provider (MusicBrainz). */
  group: string;
  release: string;
  title: string;
  artists: string[];
  year: number | null;
  /** 0 to 1. */
  similarity: number;
}
