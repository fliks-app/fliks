import Foundation

// MARK: - Paging

/// Matches the backend's `{ data, total }` list envelope (MediaService.getAll
/// and friends) — NOT `{ items, ... }` like some other Fliks list endpoints.
struct Paginated<T: Codable>: Codable {
    let data: [T]
    let total: Int
}

// MARK: - Auth

struct TokenPair: Codable {
    let accessToken: String
    let refreshToken: String
    /** UNIX seconds. */
    let accessTokenExpiresAt: Int
    let refreshTokenExpiresAt: Int
}

/// POST /auth/login response. Tokens are non-optional here — the only
/// implemented login path (local) always issues a fresh pair.
struct LoginResponse: Codable {
    let user: User
    let accessToken: String
    let refreshToken: String
    let accessTokenExpiresAt: Int
    let refreshTokenExpiresAt: Int
}

/// GET /auth/me. Field set mirrors `PublicUser` (backend) / `User` (Angular
/// client) — `safeUser()` strips `passwordHash`/`userRole`, adds `role` +
/// `permissions` + `libraryIds`.
struct User: Codable, Identifiable, Hashable {
    let id: Int
    let username: String
    let email: String?
    let role: String?
    let roleId: Int?
    let isAdmin: Bool
    let permissions: [String]
    let avatar: String?
    let requirePasswordChange: Bool
    let libraryOrder: [Int]
    let hiddenLibraryIds: [Int]
    /// "public" | "private" — ProfileVisibility enum, kept as raw string.
    let profileVisibility: String
    let shareTastes: Bool
    let shareRecommendations: Bool
    let shareWatchHistory: Bool
    let shareLikes: Bool
    let shareStats: Bool
    let shareDisabled: Bool
    // TODO: verify — safeUser() does not hydrate libraryIds (auth payloads
    // carry no ACL per its own comment); included here for parity with the
    // Angular User/PublicUser shape but likely always `[]` from /auth/me.
    let libraryIds: [Int]?
}

/// GET /auth/users-public — pre-login picker. Deliberately thin: no email,
/// role, or lastLogin.
struct PublicUser: Codable, Identifiable, Hashable {
    let id: Int
    let username: String
    let avatar: String?
}

// MARK: - Pairing (quick connect)

struct PairingRequestResponse: Codable {
    let pairingId: String
    let expiresIn: Int
}

struct PairingStatusResponse: Codable {
    /// "pending" | "approved" | "denied" | "expired"
    let status: String
    let accessToken: String?
    let refreshToken: String?
    let accessTokenExpiresAt: Int?
    let refreshTokenExpiresAt: Int?
}

// MARK: - Library

struct Library: Codable, Identifiable, Hashable {
    let id: Int
    let name: String
    let icon: String?
    let color: String?
    /// Raw MediaType values: "movie" | "series".
    let mediaTypes: [String]
    let isDefaultForMovies: Bool
    let isDefaultForSeries: Bool
}

// MARK: - Media file / stream info

struct VideoStreamInfo: Codable, Hashable {
    let streamIndex: Int
    let codec: String
    let profile: String?
    let level: Int?
    let width: Int?
    let height: Int?
    let displayAspectRatio: String?
    let pixelFormat: String?
    let frameRate: String?
    let bitRate: Int?
    let bitDepth: Int?
    let colorSpace: String?
    let colorTransfer: String?
    let colorPrimaries: String?
    let hdrFormat: String?
    let dvProfile: Int?
    let dvBlSignalCompatId: Int?
}

struct AudioStreamInfo: Codable, Hashable {
    let streamIndex: Int
    let codec: String
    let language: String
    let title: String?
    let channels: Int?
    let channelLayout: String?
    let sampleRate: Int?
    let bitRate: Int?
    let isDefault: Bool?
}

struct SubtitleStreamInfo: Codable, Hashable {
    let streamIndex: Int
    let codec: String
    let language: String
    let title: String?
    let forced: Bool
    let hearingImpaired: Bool
}

struct Chapter: Codable, Hashable {
    let startSeconds: Double
    let endSeconds: Double
    let title: String?
}

struct MediaFileInfo: Codable, Hashable {
    let video: [VideoStreamInfo]
    let audio: [AudioStreamInfo]
    let subtitles: [SubtitleStreamInfo]
    let formatBitRate: Int?
    let durationSeconds: Double?
    let chapters: [Chapter]?
    let error: String?
}

struct MediaFile: Codable, Identifiable, Hashable {
    let id: Int
    let quality: String
    let relativePath: String
    let size: Int
    let episodeId: Int?
    let streamInfo: MediaFileInfo?
}

extension Media {
    /// The file backing a movie (`episodeId == nil`) or a specific episode —
    /// same match `MediaDetailView` uses to resolve its play target.
    func fileId(episodeId: Int?) -> Int? {
        files?.first(where: { $0.episodeId == episodeId })?.id
    }
}

// MARK: - Season / Episode

struct Episode: Codable, Identifiable, Hashable {
    let id: Int
    let episodeNumber: Int
    /// Last episode number for multi-episode files (S07E25-E26 → 26); nil = single.
    let endEpisodeNumber: Int?
    let title: String?
    let overview: String?
    let airDate: String?
    let monitored: Bool
    let hasFile: Bool
    let runtime: Int?
    let stillUrl: String?
}

struct Season: Codable, Identifiable, Hashable {
    let id: Int
    let seasonNumber: Int
    let monitored: Bool
    let preferredProvider: String?
    /// Season-specific poster; nil falls back to the series `posterUrl`.
    let posterUrl: String?
    let episodes: [Episode]
}

// MARK: - Media

struct Media: Codable, Identifiable, Hashable {
    let id: Int
    let title: String
    let originalTitle: String?
    let year: Int?
    /// "movie" | "series"
    let type: String
    let tmdbId: Int?
    let overview: String?
    let status: String?
    let monitored: Bool?
    let posterUrl: String?
    let fanartUrl: String?
    /// Transparent PNG clearlogo (title treatment), or nil.
    let logoUrl: String?
    /// Extra fanarts (variants `fanart-1`..`fanart-N`), mixed with `fanartUrl`
    /// for a randomised background.
    let additionalFanartUrls: [String]
    let rating: Double?
    let genres: [String]?
    let runtime: Int?
    let releaseDate: String?
    let seasons: [Season]?
    let files: [MediaFile]?
    /// Fully watched (movie completed / series all episodes watched), per user.
    let watched: Bool?
    /// Resume progress 0-100 (movies only; 0 for series).
    let progressPercent: Double?
    let imdbId: String?
}

// MARK: - Cast / crew

struct MediaPerson: Codable, Hashable {
    let id: Int
    let name: String
    let avatarUrl: String?
}

/// GET /media/:id/cast row.
struct MediaCastEntry: Codable, Identifiable, Hashable {
    let id: Int
    let character: String
    let order: Int
    let person: MediaPerson
}

/// GET /media/:id/crew row. Not currently rendered anywhere (only the cast
/// Rail is) — modelled for parity now that the endpoint shape is confirmed.
struct MediaCrewEntry: Codable, Identifiable, Hashable {
    let id: Int
    let job: String
    let department: String
    let person: MediaPerson
}

// MARK: - Continue watching / recommendations

struct ContinueWatchingItem: Codable, Identifiable {
    let mediaId: Int
    let mediaFileId: Int?
    let episodeId: Int?
    let positionSeconds: Double
    let durationSeconds: Double
    let progressPercent: Double
    let lastPlayedAt: Date
    let mediaTitle: String
    /// "movie" | "series"
    let mediaType: String
    let posterUrl: String?
    let fanartUrl: String?
    /// Episode still — nil for movie rows or when TMDB had no still.
    let stillUrl: String?
    let episodeLabel: String?

    /// The backend join id can be null/duplicated across rows — identify by
    /// media (+episode) so ForEach never drops a card (mirrors web #797).
    var id: String { "\(mediaId)-\(episodeId ?? 0)" }
}

struct RecommendationItem: Codable, Identifiable {
    struct MediaSummary: Codable, Hashable {
        let id: Int
        let title: String
        let type: String
        let year: Int?
        let posterUrl: String?
        let fanartUrl: String?
        let additionalFanartUrls: [String]
        let genres: [String]
        /// True when actually playable (≥1 downloaded file/episode).
        let available: Bool
    }

    let media: MediaSummary
    let becauseTitle: String
    let score: Double

    var id: Int { media.id }
}

// MARK: - Playback info

struct TranscodeReason: Codable, Hashable {
    let flag: String
    let message: String
}

struct AudioPlan: Codable, Hashable {
    /// "copy" | "transcode"
    let mode: String
    let codec: String
    let bitrateBps: Int?
}

/// Per-audio-track copy/transcode decision, one entry per source audio
/// stream (source order == `streamInfo.audio` order).
struct AudioTrackPlan: Codable, Hashable {
    let index: Int
    let language: String?
    let codec: String
    let channels: Int?
    let copy: Bool
    let outputCodec: String
    let outputChannels: Int?
    let reasonFlags: [String]
}

struct QualityOption: Codable, Hashable, Identifiable {
    /// "original" | "2160p" | "1080p" | ... | "144p"
    let id: String
    let label: String
    let height: Int
    let width: Int?
    let totalBitrateBps: Int
    let isRemux: Bool
    let lowBandwidth: Bool?
}

struct PlaybackSourceInfo: Codable, Hashable {
    let container: String
    let videoCodec: String
    let width: Int?
    let height: Int?
    let frameRate: String?
    let audioCodec: String
    let audioChannels: Int?
    let audioLanguage: String?
    let durationSeconds: Double?
    let hdrFormat: String?
}

struct PlaybackMarker: Codable, Hashable {
    let startSeconds: Double
    let endSeconds: Double
}

struct PlaybackMarkers: Codable, Hashable {
    let intro: PlaybackMarker?
    let outro: PlaybackMarker?
}

/// GET /playback/media/:id — which file/episode to resume, or nil when
/// nothing is in progress. `positionSeconds` is pre-zeroed by the backend
/// when under its "resume from start" threshold.
struct MediaResumeInfo: Codable, Hashable {
    let mediaFileId: Int
    let episodeId: Int?
    let positionSeconds: Double
    let durationSeconds: Double
    let seasonNumber: Int?
    let episodeNumber: Int?
}

// MARK: - Home zones (calendar / playlists / likes / requests)

/// GET /media/calendar row. Coming-soon filtering (`!hasFile` + event kind)
/// and mediaId dedup happen client-side, matching the Angular home page.
struct CalendarEntry: Codable, Identifiable {
    let id: Int
    let mediaId: Int
    let title: String
    /// "digital" | "airing" | "release" | ...
    let event: String
    /// "YYYY-MM-DD"
    let date: String
    let posterUrl: String?
    let hasFile: Bool?
}

/// GET /playlists row (lean projection — full item list is a later phase).
struct Playlist: Codable, Identifiable {
    let id: Int
    let name: String
    let itemCount: Int
    /// First up-to-4 poster URLs for the card mosaic.
    let posters: [String]
    let updatedAt: Date
}

/// GET /playlists/:id/items row. `media` is the movie, or the parent series
/// when the item is an episode; it carries no `files` (unhydrated
/// server-side) — playback resolves the file via a fresh GET /media/:id
/// (see `Media.fileId(episodeId:)`).
struct PlaylistItem: Codable, Identifiable {
    let itemId: Int
    let media: Media
    /// Set when the item is a single episode; nil for a movie item.
    let episode: PlaylistEpisode?
    let progressPercent: Double
    let watched: Bool

    var id: Int { itemId }
}

/// Inlined episode fields for a playlist episode item (no standalone episode fetch).
struct PlaylistEpisode: Codable, Hashable {
    let id: Int
    let episodeNumber: Int
    let endEpisodeNumber: Int?
    let title: String?
    let stillUrl: String?
    let runtime: Int?
    let season: PlaylistEpisodeSeason?
}

struct PlaylistEpisodeSeason: Codable, Hashable {
    let seasonNumber: Int
}

/// GET /likes row. No `id` field on the wire — Identifiable via a synthetic
/// key mirroring the Angular `@for` track expression.
struct LikedItem: Codable {
    let mediaId: Int
    let title: String
    let posterUrl: String?
    let fanartUrl: String?
    let seasonId: Int?
    let episodeId: Int?
    let label: String?
    let stillUrl: String?
}

extension LikedItem: Identifiable {
    var id: String { "\(mediaId)-\(seasonId ?? -1)-\(episodeId ?? -1)" }
}

/// GET /likes/state/:mediaId — the caller's like state for a media.
struct LikeState: Codable, Hashable {
    let media: Bool
    let seasonIds: [Int]
    let episodeIds: [Int]
}

/// Thin projection of a `FliksRequestRow` (backend `requests` module) for the
/// home "recent requests" zone card — status + art only, not the full
/// requests-feature shape (profiles, decline reason, etc. are a later phase).
struct RequestSummary: Codable, Identifiable {
    let id: Int
    let title: String
    let mediaId: Int?
    /// "pending" | "approved" | "declined" | "processing" | "available" | "failed"
    let status: String
    let posterUrl: String?
    let fanartUrl: String?
}

/// POST /streaming/{mediaFileId}/playback-info response — the backend's
/// DirectPlay/DirectStream/Transcode decision. Admin/overlay-only fields
/// (tonemapAlgo, tonemapCurve, transcodeBitrateByQuality,
/// remuxMasterBandwidthBps) are intentionally not modelled yet — not needed
/// until the player phase, cheap to add then.
struct PlaybackInfoResponse: Codable {
    let mediaFileId: Int
    /// "DirectPlay" | "DirectStream" | "Transcode"
    let playMethod: String
    let playUrl: String
    let contentType: String
    let transcodeReasons: [TranscodeReason]
    let videoCopyStream: Bool
    let audioCopyStream: Bool
    let outputVideoCodec: String
    let outputAudioCodec: String
    let audioPlan: AudioPlan
    let outputContainer: String
    let hwAccel: String
    let tonemapping: Bool
    let qualities: [QualityOption]?
    let audioTracks: [AudioTrackPlan]?
    let source: PlaybackSourceInfo
    let durationSeconds: Double?
    let markers: PlaybackMarkers?
    let chapters: [Chapter]?
    let sessionId: String
    let profileHash: String?
}
