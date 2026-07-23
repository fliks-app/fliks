import SwiftUI
import Foundation

/// Lifecycle of a zone's async fetch.
enum ZoneState<T> {
    case loading
    case loaded([T])
    case failed

    var items: [T] {
        if case .loaded(let items) = self { return items }
        return []
    }
}

/// One zone row: title + its data lifecycle — skeleton while loading, the
/// rail once loaded, nothing when loaded-but-empty (mirrors the Angular
/// `@if (x().length)` gate), or a compact retry line on failure.
struct ZoneRow<Item: Identifiable, Card: View>: View {
    let title: String
    var portrait = true
    let state: ZoneState<Item>
    var onRetry: (() -> Void)?
    let card: (Item) -> Card

    init(title: String, portrait: Bool = true, state: ZoneState<Item>, onRetry: (() -> Void)? = nil,
         @ViewBuilder card: @escaping (Item) -> Card) {
        self.title = title
        self.portrait = portrait
        self.state = state
        self.onRetry = onRetry
        self.card = card
    }

    var body: some View {
        switch state {
        case .loading:
            SkeletonRail(title: title, portrait: portrait)
        case .loaded(let items):
            if items.isEmpty {
                EmptyView()
            } else {
                Rail(title: title, items: items, card: card)
            }
        case .failed:
            VStack(alignment: .leading, spacing: 12) {
                Text(title).font(.title2.bold())
                HStack(spacing: 20) {
                    Text(tr("home.zone_error")).foregroundStyle(.secondary)
                    if let onRetry {
                        Button(tr("common.retry"), action: onRetry)
                    }
                }
            }
        }
    }
}

/// Dispatches one resolved zone to its row implementation.
struct HomeRow: View {
    let section: ResolvedHomeSection
    let librariesState: ZoneState<Library>
    var onRetryLibraries: () -> Void
    var onSelectMedia: (Int) -> Void
    var onSelectLibrary: (Int) -> Void
    var onSelectPlaylist: (Int) -> Void

    var body: some View {
        switch section.type {
        case .receivedRecommendations:
            // Parity with the web client: this social surface is hidden on
            // every TV form factor (`!tv.isTv()` gate on the Angular card).
            EmptyView()
        case .libraries:
            LibrariesRow(state: librariesState, onRetry: onRetryLibraries, onSelect: onSelectLibrary)
        case .continueWatching:
            ContinueWatchingRow(onSelect: onSelectMedia)
        case .recommendations:
            RecommendationsRow(onSelect: onSelectMedia)
        case .likes:
            LikesRow(onSelect: onSelectMedia)
        case .recentlyAdded:
            RecentlyAddedRow(title: tr("home.recent_media"), libraryId: nil, onSelect: onSelectMedia)
        case .playlists:
            PlaylistsRow(onSelect: onSelectPlaylist)
        case .comingSoon:
            ComingSoonRow(onSelect: onSelectMedia)
        case .requestsRecent:
            RequestsRecentRow(onSelect: onSelectMedia)
        case .libraryRecent:
            RecentlyAddedRow(
                title: tr("home.recent_media_in", section.libraryName ?? ""),
                libraryId: section.libraryId,
                onSelect: onSelectMedia
            )
        }
    }
}

// MARK: - Libraries

private struct LibrariesRow: View {
    let state: ZoneState<Library>
    var onRetry: () -> Void
    var onSelect: (Int) -> Void

    var body: some View {
        ZoneRow(title: tr("home.libraries"), portrait: false, state: state, onRetry: onRetry) { lib in
            LibraryTile(library: lib) { onSelect(lib.id) }
        }
    }
}

private struct LibraryTile: View {
    let library: Library
    var onSelect: () -> Void
    @FocusState private var focused: Bool

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 14) {
                Image(systemName: symbol)
                    .font(.title2)
                Text(library.name).font(.headline).lineLimit(1)
            }
            .padding(.horizontal, 22)
            .frame(width: 280, height: 110, alignment: .leading)
            .background(Color.accentColor.opacity(focused ? 0.4 : 0.18), in: RoundedRectangle(cornerRadius: 16))
        }
        .buttonStyle(.card)
        .focused($focused)
    }

    // ponytail: a fixed SF Symbol per rough category stands in for the
    // Angular lucide-icon + per-library color; add a real icon/color mapping
    // if libraries want a more distinct look on TV.
    private var symbol: String {
        switch library.icon {
        case "film": "film"
        case "tv", "monitor": "tv"
        case "music": "music.note"
        case "book", "book-open": "book"
        default: "folder.fill"
        }
    }
}

// MARK: - Continue watching

private struct ContinueWatchingRow: View {
    var onSelect: (Int) -> Void
    @Environment(Backdrop.self) private var backdrop
    @Environment(HomeRefresh.self) private var refresh
    @State private var state: ZoneState<ContinueWatchingItem> = .loading

    var body: some View {
        ZoneRow(title: tr("home.continue_watching"), portrait: false, state: state, onRetry: { Task { await load() } }) { item in
            MediaCard(imagePath: item.stillUrl ?? item.fanartUrl ?? item.posterUrl,
                      title: item.mediaTitle, subtitle: item.episodeLabel, portrait: false,
                      progressPercent: item.progressPercent, backdropPath: item.fanartUrl) {
                onSelect(item.mediaId)
            }
        }
        .task(id: refresh.tick) { await load() }
    }

    private func load() async {
        state = .loading
        do {
            let items: [ContinueWatchingItem] = try await APIClient.shared.get("/api/playback/continue-watching")
            state = .loaded(items)
            backdrop.seed(items.first?.fanartUrl)
        } catch {
            state = .failed
        }
    }
}

// MARK: - Recommendations

private struct RecommendationsRow: View {
    var onSelect: (Int) -> Void
    @Environment(Backdrop.self) private var backdrop
    @Environment(HomeRefresh.self) private var refresh
    @State private var state: ZoneState<RecommendationItem> = .loading

    var body: some View {
        ZoneRow(title: tr("home.recommendations"), state: state, onRetry: { Task { await load() } }) { rec in
            MediaCard(imagePath: rec.media.posterUrl, title: rec.media.title,
                      subtitle: rec.media.year.map(String.init), backdropPath: rec.media.fanartUrl) {
                onSelect(rec.media.id)
            }
        }
        .task(id: refresh.tick) { await load() }
    }

    private func load() async {
        state = .loading
        do {
            let items: [RecommendationItem] = try await APIClient.shared.get("/api/playback/recommendations")
            state = .loaded(items)
            backdrop.seed(items.first?.media.fanartUrl)
        } catch {
            state = .failed
        }
    }
}

// MARK: - Likes

private struct LikesRow: View {
    var onSelect: (Int) -> Void
    @Environment(Backdrop.self) private var backdrop
    @Environment(HomeRefresh.self) private var refresh
    @State private var state: ZoneState<LikedItem> = .loading

    var body: some View {
        ZoneRow(title: tr("home.likes"), portrait: false, state: state, onRetry: { Task { await load() } }) { item in
            MediaCard(imagePath: item.stillUrl ?? item.fanartUrl ?? item.posterUrl,
                      title: item.title, subtitle: item.label, portrait: false, backdropPath: item.fanartUrl) {
                onSelect(item.mediaId)
            }
        }
        .task(id: refresh.tick) { await load() }
    }

    private func load() async {
        state = .loading
        do {
            let items: [LikedItem] = try await APIClient.shared.get("/api/likes")
            state = .loaded(items)
            backdrop.seed(items.first?.fanartUrl)
        } catch {
            state = .failed
        }
    }
}

// MARK: - Recently added (shared by the built-in row and per-library rows)

private struct RecentlyAddedRow: View {
    let title: String
    let libraryId: Int?
    var onSelect: (Int) -> Void
    @Environment(Backdrop.self) private var backdrop
    @Environment(HomeSettingsStore.self) private var homeSettings
    @Environment(HomeRefresh.self) private var refresh
    @State private var state: ZoneState<Media> = .loading

    var body: some View {
        ZoneRow(title: title, state: state, onRetry: { Task { await load() } }) { m in
            MediaCard(imagePath: m.posterUrl, title: m.title, subtitle: m.year.map(String.init),
                      backdropPath: m.fanartUrl) {
                onSelect(m.id)
            }
        }
        .task(id: "\(refresh.tick)|\(homeSettings.settings.recentlyAddedMode.rawValue)") { await load() }
    }

    private func load() async {
        state = .loading
        var query = ["mode": homeSettings.settings.recentlyAddedMode.rawValue, "limit": "20", "excludeWatched": "true"]
        if let libraryId { query["libraryId"] = String(libraryId) }
        do {
            let items: [Media] = try await APIClient.shared.get("/api/media/recently-added", query: query)
            state = .loaded(items)
            backdrop.seed(items.first?.fanartUrl)
        } catch {
            state = .failed
        }
    }
}

// MARK: - Playlists

private struct PlaylistsRow: View {
    var onSelect: (Int) -> Void
    @Environment(HomeRefresh.self) private var refresh
    @State private var state: ZoneState<Playlist> = .loading

    var body: some View {
        ZoneRow(title: tr("home.playlists"), state: state, onRetry: { Task { await load() } }) { p in
            // ponytail: the first poster stands in for Angular's 4-up mosaic
            // card; swap in a real mosaic if a single poster reads as too thin.
            MediaCard(imagePath: p.posters.first, title: p.name, subtitle: String(p.itemCount)) {
                onSelect(p.id)
            }
        }
        .task(id: refresh.tick) { await load() }
    }

    private func load() async {
        state = .loading
        do {
            let items: [Playlist] = try await APIClient.shared.get("/api/playlists")
            let sorted = items.sorted { $0.updatedAt > $1.updatedAt }.prefix(20)
            state = .loaded(Array(sorted))
        } catch {
            state = .failed
        }
    }
}

// MARK: - Coming soon

private struct ComingSoonRow: View {
    var onSelect: (Int) -> Void
    @Environment(HomeRefresh.self) private var refresh
    @State private var state: ZoneState<CalendarEntry> = .loading

    var body: some View {
        ZoneRow(title: tr("home.coming_soon"), state: state, onRetry: { Task { await load() } }) { entry in
            MediaCard(imagePath: entry.posterUrl, title: entry.title, subtitle: entry.date) {
                onSelect(entry.mediaId)
            }
        }
        .task(id: refresh.tick) { await load() }
    }

    private func load() async {
        state = .loading
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.timeZone = TimeZone(identifier: "UTC")
        let today = Date()
        let start = Calendar.current.date(byAdding: .day, value: -3, to: today) ?? today
        let end = Calendar.current.date(byAdding: .day, value: 30, to: today) ?? today
        do {
            let entries: [CalendarEntry] = try await APIClient.shared.get(
                "/api/media/calendar",
                query: ["start": df.string(from: start), "end": df.string(from: end), "monitoredOnly": "true"]
            )
            let upcoming = entries
                .filter { !($0.hasFile ?? false) && ["digital", "airing", "release"].contains($0.event) }
                .sorted { $0.date < $1.date }
            var seen = Set<Int>()
            state = .loaded(upcoming.filter { seen.insert($0.mediaId).inserted })
        } catch {
            state = .failed
        }
    }
}

// MARK: - Recent requests (permission-gated by HomeSettingsStore.resolve)

private struct RequestsRecentRow: View {
    var onSelect: (Int) -> Void
    @Environment(HomeRefresh.self) private var refresh
    @State private var state: ZoneState<RequestSummary> = .loading

    var body: some View {
        ZoneRow(title: tr("home.requests_recent"), state: state, onRetry: { Task { await load() } }) { req in
            MediaCard(imagePath: req.posterUrl ?? req.fanartUrl, title: req.title, subtitle: req.status) {
                if let mediaId = req.mediaId { onSelect(mediaId) }
            }
        }
        .task(id: refresh.tick) { await load() }
    }

    private func load() async {
        state = .loading
        do {
            let page: Paginated<RequestSummary> = try await APIClient.shared.get("/api/requests", query: ["limit": "12"])
            state = .loaded(page.data)
        } catch {
            state = .failed
        }
    }
}
