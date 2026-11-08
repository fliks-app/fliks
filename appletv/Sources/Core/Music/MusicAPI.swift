import Foundation

/// The music routes the screens read and write.
enum MusicAPI {
    private static var api: APIClient { .shared }

    static func albumPage(_ mediaId: Int) async throws -> AlbumPage {
        try await api.get("/api/media/\(mediaId)")
    }

    static func albums(libraryId: Int, sortBy: String, sortOrder: String, page: Int, limit: Int) async throws -> Paginated<AlbumCard> {
        try await api.get("/api/media", query: [
            "libraryId": String(libraryId), "type": "album", "sortBy": sortBy, "sortOrder": sortOrder,
            "page": String(page), "limit": String(limit),
        ])
    }

    static func searchAlbums(_ q: String, limit: Int) async throws -> [AlbumCard] {
        let res: Paginated<AlbumCard> = try await api.get("/api/media", query: ["q": q, "type": "album", "limit": String(limit)])
        return res.data
    }

    static func recentlyPlayed(limit: Int = 20) async -> [AlbumCard] {
        (try? await api.get("/api/playback/recently-played", query: ["limit": String(limit)])) ?? []
    }

    static func tracks(libraryId: Int? = nil, q: String? = nil, favourite: Bool = false, sortBy: String = "title",
                       sortOrder: String = "asc", page: Int = 1, limit: Int = 50) async throws -> [TrackRow] {
        var query = ["sortBy": sortBy, "sortOrder": sortOrder, "page": String(page), "limit": String(limit)]
        if let libraryId { query["libraryId"] = String(libraryId) }
        if let q, !q.isEmpty { query["q"] = q }
        if favourite { query["favourite"] = "true" }
        return try await api.get("/api/tracks", query: query)
    }

    static func artists(libraryId: Int? = nil, q: String? = nil, page: Int = 1, limit: Int = 60) async throws -> [MusicPersonRow] {
        var query = ["role": "artist", "page": String(page), "limit": String(limit)]
        if let libraryId { query["libraryId"] = String(libraryId) }
        if let q, !q.isEmpty { query["q"] = q }
        return try await api.get("/api/persons", query: query)
    }

    static func discography(_ personId: Int) async throws -> Discography {
        try await api.get("/api/persons/\(personId)/discography")
    }

    /// Favourites ride on the likes route: the track item goes where an episode id does.
    static func setFavourite(_ on: Bool, mediaId: Int, itemId: Int) async throws {
        struct Target: Encodable { let mediaId: Int; let episodeId: Int }
        let body = Target(mediaId: mediaId, episodeId: itemId)
        if on { try await api.post("/api/likes", body: body) } else { try await api.delete("/api/likes", body: body) }
    }

    /// `nil` clears the rating.
    static func rate(_ rating: Int?, itemId: Int) async throws {
        if let rating {
            try await api.put("/api/items/\(itemId)/rating", body: ["rating": rating])
        } else {
            try await api.delete("/api/items/\(itemId)/rating")
        }
    }
}

extension QueueTrack {
    init(track t: Track, album: AlbumPage, edition: AlbumEdition?) {
        let artists = t.artists.isEmpty ? album.album.artists.map(\.name).joined(separator: ", ") : MusicFormat.artistLine(t.artists)
        self.init(itemId: t.itemId, mediaId: album.id, title: t.title, artists: artists, albumTitle: album.title,
                  coverUrl: edition?.coverUrl ?? album.posterUrl, durationSeconds: t.durationSeconds, gain: t.gain,
                  peak: t.peak, albumGain: edition?.albumGain, albumPeak: edition?.albumPeak)
    }

    init(row r: TrackRow) {
        self.init(itemId: r.itemId, mediaId: r.mediaId, title: r.title, artists: MusicFormat.artistLine(r.artists),
                  albumTitle: r.albumTitle, coverUrl: r.posterUrl, durationSeconds: r.durationSeconds, gain: r.gain,
                  peak: r.peak, albumGain: nil, albumPeak: nil)
    }

    init(entry t: PlaylistTrack) {
        self.init(itemId: t.itemId, mediaId: t.mediaId, title: t.title, artists: t.artists.joined(separator: ", "),
                  albumTitle: t.albumTitle, coverUrl: t.posterUrl, durationSeconds: t.durationSeconds, gain: nil,
                  peak: nil, albumGain: nil, albumPeak: nil)
    }
}

extension AlbumPage {
    /// The tracks of one edition that have a file, ready for the player.
    func queue(edition: AlbumEdition?) -> [QueueTrack] {
        let id = edition?.id
        return album.tracks.filter { $0.playable && (id == nil || $0.editionId == id) }
            .map { QueueTrack(track: $0, album: self, edition: edition) }
    }
}
