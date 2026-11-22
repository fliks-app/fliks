// Wire contract: the F4 section of the music plan (tracks are named by `itemId`)

import type { KaraokeStage } from './karaoke.models';

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
  /** The release group this release belongs to. */
  releaseGroupId: string | null;
  /** The release's own label ("Deluxe", "Live"); null when the provider sends none. */
  disambiguation: string | null;
  trackCount: number;
  discCount: number;
  durationSeconds: number;
  playCount: number;
}

/** The release an album is: one pressing with its own tracklist. */
export interface AlbumRelease {
  title: string | null;
  country: string | null;
  status: string | null;
  media: string | null;
  barcode: string | null;
  catalogNumber: string | null;
  label: string | null;
  disambiguation: string | null;
  releaseDate: string | null;
  trackCount: number;
  discCount: number;
  albumGain: number | null;
  albumPeak: number | null;
  coverUrl: string | null;
}

/** Another release of the album's release group: held (`mediaId`) or only listed by the provider. */
export interface AlbumVersion {
  releaseId: string;
  title: string;
  disambiguation: string | null;
  country: string | null;
  releaseDate: string | null;
  trackCount: number | null;
  discCount: number | null;
  mediaId: number | null;
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
  /** The playable part's file; null when the track has none. */
  mediaFileId: number | null;
  hasFile: boolean;
  /** Wanted: an unwanted track of the release stays listed, greyed. */
  monitored: boolean;
  orphaned: boolean;
  /** The newest finished acquisition covering the track (queue state). */
  lastAttempt?: 'imported' | 'failed' | 'import_failed' | 'removed' | null;
  /** The karaoke prep under way, when any; follows `karaoke.job_changed`. */
  karaoke?: { state: 'queued' | 'running'; stage?: KaraokeStage; progress: number | null } | null;
  discNumber: number;
  discTitle: string | null;
  position: number;
  trackNumber: number | null;
  label: string | null;
  title: string;
  /** MusicBrainz recording id; null when the track has none. */
  recordingId?: string | null;
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
  releaseGroupId: string | null;
  orphaned: boolean;
  artists: AlbumArtist[];
  release: AlbumRelease | null;
  /** Tracks of other albums that play this album's files: what a delete reopens. */
  sharedTracks: number;
  /** The other releases of the group, this one included. */
  versions: AlbumVersion[];
  /** The whole tracklist by disc number, position. */
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
  /** Comma-separated item ids (at most 500): the readable ones, in that order. */
  ids?: string;
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
  /** Owned albums only: the release's group and its own label. */
  releaseGroupId?: string | null;
  disambiguation?: string | null;
  posterUrl: string | null;
  owned: boolean;
  monitored: boolean;
  trackCount: number;
  ownedTrackCount: number;
}

/** One discography card: the releases of a release group folded into its most owned one. */
export interface ArtistAlbumGroup extends ArtistAlbum {
  versions: number;
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
  /** The provider's discography failed: `albums` holds the owned ones only. */
  partial: boolean;
  popular: PopularTrack[];
}

/** One of the artist's most listened recordings; `track` is the owned copy, null when the library has none. */
export interface PopularTrack {
  recordingId: string;
  title: string;
  durationMs: number | null;
  listenCount: number | null;
  albumExternalId: string | null;
  albumTitle: string | null;
  coverUrl: string | null;
  track: TrackRow | null;
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
  gain: number | null;
  peak: number | null;
}

// GET /api/metadata/:provider/album/:externalId
export interface AlbumPreview {
  provider: string;
  externalId: string;
  title: string;
  year: number | null;
  posterUrl: string | null;
  artists: { name: string; creditedName: string | null; joinPhrase: string | null; externalId: string | null }[];
  releaseGroupId: string | null;
  release: { externalId: string; title: string; disambiguation: string | null; country: string | null; releaseDate: string | null } | null;
  tracks: AlbumPreviewTrack[];
  trackCount: number;
  durationMs: number;
  existingMediaId: number | null;
}

// GET /api/music/albums/tracks
export interface AlbumPreviewTrack {
  recordingId: string | null;
  discNumber: number;
  position: number;
  number: number | null;
  title: string;
  durationMs: number | null;
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
