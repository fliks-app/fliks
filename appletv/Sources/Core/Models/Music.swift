import Foundation

// MARK: - Wire models of the music routes (the F4 contract of the web client)

struct MusicPerson: Codable, Hashable, Identifiable {
    let id: Int
    let name: String
    let sortName: String?
    let avatarUrl: String?
}

struct MusicPersonRow: Codable, Hashable, Identifiable {
    let id: Int
    let name: String
    let avatarUrl: String?
    let albumCount: Int
    let trackCount: Int
}

struct AlbumArtist: Codable, Hashable {
    let id: Int
    let name: String
    let creditedName: String?
    let joinPhrase: String?
}

/// `album` of a `GET /api/media?type=album` row.
struct AlbumListInfo: Codable, Hashable {
    let artists: [MusicPerson]
    let primaryType: String?
    let secondaryTypes: [String]
    let firstReleaseDate: String?
    let isCompilation: Bool
    let trackCount: Int
    let discCount: Int
    let durationSeconds: Double
    let playCount: Int
}

/// A row of the albums grid: the media plus the `album` block of the list.
struct AlbumCard: Codable, Identifiable, Hashable {
    let id: Int
    let title: String
    let year: Int?
    let posterUrl: String?
    let fanartUrl: String?
    let album: AlbumListInfo?

    private enum CodingKeys: String, CodingKey { case id, title, year, posterUrl, fanartUrl, album }

    /// A row that carries another shape of `album` (a detail block) still lists, without the artists.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        year = try c.decodeIfPresent(Int.self, forKey: .year)
        posterUrl = try c.decodeIfPresent(String.self, forKey: .posterUrl)
        fanartUrl = try c.decodeIfPresent(String.self, forKey: .fanartUrl)
        album = try? c.decodeIfPresent(AlbumListInfo.self, forKey: .album)
    }

    var artistLine: String? {
        guard let names = album?.artists.map(\.name), !names.isEmpty else { return nil }
        return names.joined(separator: ", ")
    }
}

struct AlbumEdition: Codable, Hashable, Identifiable {
    let id: Int
    let title: String?
    let country: String?
    let status: String?
    let media: String?
    let barcode: String?
    let catalogNumber: String?
    let label: String?
    let releaseDate: String?
    let trackCount: Int
    let discCount: Int
    let albumGain: Double?
    let albumPeak: Double?
    let coverUrl: String?
    let libraryId: Int?
    let hasFiles: Bool
    let orphaned: Bool
}

struct TrackArtist: Codable, Hashable {
    let id: Int?
    let name: String
    let creditedName: String?
    let joinPhrase: String?
}

struct TrackCredit: Codable, Hashable {
    let personId: Int
    let name: String
    /// composer, lyricist, performer, conductor, orchestra or ensemble.
    let role: String
    let instrument: String?
}

struct Track: Codable, Hashable, Identifiable {
    let itemId: Int
    let editionId: Int
    let mediaFileId: Int?
    let hasFile: Bool
    let orphaned: Bool
    let discNumber: Int
    let discTitle: String?
    let position: Int
    let trackNumber: Int?
    let label: String?
    let title: String
    let durationSeconds: Double?
    let explicit: Bool
    let gain: Double?
    let peak: Double?
    let artists: [TrackArtist]
    let credits: [TrackCredit]
    var favourite: Bool
    let playCount: Int
    let lastPlayedAt: String?

    var id: Int { itemId }
    var playable: Bool { hasFile && !orphaned }
}

/// `album` of `GET /api/media/:id` for an album.
struct AlbumDetail: Codable, Hashable {
    let primaryType: String?
    let secondaryTypes: [String]
    let firstReleaseDate: String?
    let isCompilation: Bool
    let targetEditionId: Int?
    let orphaned: Bool
    let artists: [AlbumArtist]
    let editions: [AlbumEdition]
    let tracks: [Track]
}

/// `GET /api/media/:id` of an album, reduced to what the page reads.
struct AlbumPage: Decodable {
    let id: Int
    let title: String
    let year: Int?
    let overview: String?
    let posterUrl: String?
    let fanartUrl: String?
    let genres: [String]?
    let album: AlbumDetail
}

/// `GET /api/tracks` row.
struct TrackRow: Codable, Hashable, Identifiable {
    let itemId: Int
    let mediaId: Int
    let mediaFileId: Int?
    let title: String
    let albumTitle: String
    let posterUrl: String?
    let durationSeconds: Double?
    let gain: Double?
    let peak: Double?
    let artists: [TrackArtist]
    var favourite: Bool

    var id: Int { itemId }
}

struct ArtistAlbum: Codable, Hashable, Identifiable {
    /// Nil: in the provider's discography, not in the library.
    let mediaId: Int?
    let externalId: String?
    let title: String
    let year: Int?
    let primaryType: String?
    let secondaryTypes: [String]
    let posterUrl: String?
    let owned: Bool

    var id: String { mediaId.map { "m\($0)" } ?? "e\(externalId ?? title)" }
}

struct ArtistInfo: Codable, Hashable {
    let id: Int
    let name: String
    let biography: String?
    let imageUrl: String?
}

/// `GET /api/persons/:id/discography`.
struct Discography: Codable {
    let artist: ArtistInfo
    let albums: [ArtistAlbum]
}

/// The track of a music playlist entry.
struct PlaylistTrack: Codable, Hashable {
    let itemId: Int
    let title: String
    let artists: [String]
    let albumTitle: String
    let mediaId: Int
    let posterUrl: String?
    let durationSeconds: Double?
    let mediaFileId: Int?
}

// MARK: - Formatting and release groups

enum MusicFormat {
    /// `m:ss`, or `h:mm:ss` from an hour up.
    static func duration(_ seconds: Double?) -> String {
        guard let seconds else { return "" }
        let s = Int(seconds.rounded())
        let (h, m, r) = (s / 3600, (s % 3600) / 60, s % 60)
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, r) : String(format: "%d:%02d", m, r)
    }

    /// The credited names with their join phrases; a missing phrase between two names is a comma.
    static func artistLine(_ artists: [TrackArtist]) -> String {
        artists.enumerated().map { i, a in
            (a.creditedName ?? a.name) + (i < artists.count - 1 ? (a.joinPhrase ?? ", ") : "")
        }.joined()
    }
}

/// Tracks of one disc, in the order the album gives.
struct Disc: Identifiable {
    let number: Int
    let title: String?
    let tracks: [Track]
    var id: Int { number }
}

extension AlbumDetail {
    /// The edition the page shows: the chosen one, else the target, else the first with files.
    func edition(_ chosen: Int?) -> AlbumEdition? {
        editions.first { $0.id == chosen } ?? editions.first { $0.id == targetEditionId }
            ?? editions.first { $0.hasFiles } ?? editions.first
    }

}

extension Disc {
    /// The tracks of one edition by disc, in the order given.
    static func group(_ tracks: [Track], edition editionId: Int?) -> [Disc] {
        var order: [Int] = []
        var byDisc: [Int: [Track]] = [:]
        var titles: [Int: String] = [:]
        for t in tracks where editionId == nil || t.editionId == editionId {
            if byDisc[t.discNumber] == nil { order.append(t.discNumber) }
            byDisc[t.discNumber, default: []].append(t)
            if let title = t.discTitle, !title.isEmpty { titles[t.discNumber] = title }
        }
        return order.map { Disc(number: $0, title: titles[$0], tracks: byDisc[$0] ?? []) }
    }
}

/// A release group of the artist page.
struct ReleaseGroup: Identifiable {
    /// i18n key of the heading.
    let key: String
    let albums: [ArtistAlbum]
    var id: String { key }
}

extension Discography {
    /// Albums by type; the ones the provider lists and the library lacks go last.
    func groups() -> [ReleaseGroup] {
        func key(_ a: ArtistAlbum) -> String {
            let secondary = a.secondaryTypes.map { $0.lowercased() }
            if secondary.contains("compilation") { return "music.group_compilation" }
            if secondary.contains("live") { return "music.group_live" }
            switch a.primaryType?.lowercased() {
            case "album": return "music.group_album"
            case "ep": return "music.group_ep"
            case "single": return "music.group_single"
            default: return "music.group_other"
            }
        }
        let order = ["music.group_album", "music.group_ep", "music.group_single", "music.group_compilation",
                     "music.group_live", "music.group_other"]
        let owned = albums.filter(\.owned)
        var out = order.compactMap { k -> ReleaseGroup? in
            let list = owned.filter { key($0) == k }.sorted { ($0.year ?? 0) > ($1.year ?? 0) }
            return list.isEmpty ? nil : ReleaseGroup(key: k, albums: list)
        }
        let missing = albums.filter { !$0.owned }
        if !missing.isEmpty { out.append(ReleaseGroup(key: "music.group_missing", albums: missing)) }
        return out
    }
}
