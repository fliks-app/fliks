import Foundation

/// Watched flags and resume progress, shared by every card and detail screen
/// so a toggle anywhere updates all of them at once.
@Observable final class WatchedStore {
    static let shared = WatchedStore()

    private(set) var watchedMedia: Set<Int> = []
    /// mediaId → 0-100, from continue-watching.
    private(set) var mediaProgress: [Int: Double] = [:]
    private(set) var watchedEpisodes: [Int: Set<Int>] = [:]
    private(set) var episodeProgress: [Int: [Int: Double]] = [:]

    private init() {}

    func isWatched(mediaId: Int, episodeId: Int? = nil) -> Bool {
        guard let episodeId else { return watchedMedia.contains(mediaId) }
        return watchedEpisodes[mediaId]?.contains(episodeId) ?? false
    }

    /// 0-100, nil when nothing is in progress.
    func progress(mediaId: Int, episodeId: Int? = nil) -> Double? {
        guard let episodeId else { return mediaProgress[mediaId] }
        return episodeProgress[mediaId]?[episodeId]
    }

    @MainActor
    func loadOverview() async {
        async let ids: [Int] = APIClient.shared.get("/api/playback/watched-ids")
        async let inProgress: [ContinueWatchingItem] = APIClient.shared.get("/api/playback/continue-watching")
        if let ids = try? await ids { watchedMedia = Set(ids) }
        if let items = try? await inProgress {
            mediaProgress = Dictionary(items.map { ($0.mediaId, $0.progressPercent) }, uniquingKeysWith: max)
        }
    }

    @MainActor
    func loadSeries(_ mediaId: Int) async {
        async let watched: [Int] = APIClient.shared.get("/api/playback/media/\(mediaId)/watched-episodes")
        async let progress: [String: Double] = APIClient.shared.get("/api/playback/media/\(mediaId)/episode-progress")
        if let watched = try? await watched { watchedEpisodes[mediaId] = Set(watched) }
        if let progress = try? await progress {
            episodeProgress[mediaId] = Dictionary(uniqueKeysWithValues: progress.compactMap { key, value in
                Int(key).map { ($0, value) }
            })
        }
    }

    @MainActor
    func toggle(mediaId: Int, episodeId: Int? = nil) async {
        struct Body: Encodable { let episodeId: Int? }
        let was = isWatched(mediaId: mediaId, episodeId: episodeId)
        apply(watched: !was, mediaId: mediaId, episodeId: episodeId)
        do {
            try await APIClient.shared.post("/api/playback/media/\(mediaId)/toggle-watched",
                                            body: Body(episodeId: episodeId))
        } catch {
            apply(watched: was, mediaId: mediaId, episodeId: episodeId)
        }
    }

    /// `episodeIds` are marked right away so the cards react before the
    /// round-trip; the server decides the real set (files, specials) and
    /// `loadSeries` reconciles.
    @MainActor
    func toggleSeries(mediaId: Int, watched: Bool, episodeIds: [Int] = []) async {
        struct Body: Encodable { let watched: Bool }
        struct Response: Decodable { let watched: Bool }

        let previousEpisodes = watchedEpisodes[mediaId]
        let previousProgress = episodeProgress[mediaId]
        watchedEpisodes[mediaId] = watched ? Set(episodeIds) : []
        if watched { episodeProgress[mediaId] = [:] }
        apply(watched: watched, mediaId: mediaId, episodeId: nil)

        guard let res: Response = try? await APIClient.shared.post(
            "/api/playback/media/\(mediaId)/toggle-series-watched", body: Body(watched: watched)
        ) else {
            watchedEpisodes[mediaId] = previousEpisodes
            episodeProgress[mediaId] = previousProgress
            apply(watched: !watched, mediaId: mediaId, episodeId: nil)
            return
        }
        apply(watched: res.watched, mediaId: mediaId, episodeId: nil)
        await loadSeries(mediaId)
    }

    func clear() {
        watchedMedia = []
        mediaProgress = [:]
        watchedEpisodes = [:]
        episodeProgress = [:]
    }

    private func apply(watched: Bool, mediaId: Int, episodeId: Int?) {
        if let episodeId {
            var ids = watchedEpisodes[mediaId] ?? []
            if watched { ids.insert(episodeId) } else { ids.remove(episodeId) }
            watchedEpisodes[mediaId] = ids
            if watched { episodeProgress[mediaId]?[episodeId] = nil }
        } else if watched {
            watchedMedia.insert(mediaId)
            mediaProgress[mediaId] = nil
        } else {
            watchedMedia.remove(mediaId)
        }
    }
}

/// Opens the add-to-playlist sheet from anywhere — cards live inside scroll
/// views that can't present it themselves, so the shell owns the sheet.
@Observable final class PlaylistPicker {
    static let shared = PlaylistPicker()

    struct Target: Identifiable, Hashable {
        let mediaId: Int
        let episodeId: Int?
        var id: String { "\(mediaId):\(episodeId ?? 0)" }
    }

    var target: Target?

    private init() {}

    func open(mediaId: Int, episodeId: Int? = nil) {
        target = Target(mediaId: mediaId, episodeId: episodeId)
    }
}
