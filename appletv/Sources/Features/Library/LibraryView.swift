import SwiftUI

/// GET /api/media?libraryId=&type=&sortBy=&sortOrder=&page=&limit= -> Paginated<Media>.
/// 6-col portrait grid (ContentGrid) with sort + type filter and infinite
/// scroll via `onReachEnd`.
struct LibraryView: View {
    let libraryId: Int
    var onSelectMedia: (Int, MediaKind) -> Void
    var onSelectArtist: (Int) -> Void

    private enum LoadState {
        case loading
        case loaded
        case failed
    }

    @State private var state: LoadState = .loading
    @State private var items: [Media] = []
    @State private var fetched = 0
    @State private var total = 0
    @State private var page = 1
    @State private var generation = 0
    @State private var isLoadingMore = false
    @State private var sortBy = "title"
    @State private var sortOrder = "ASC"
    @State private var typeFilter: MediaKind?
    @State private var library: Library?
    @Environment(Backdrop.self) private var backdrop

    private let pageSize = 60

    private var isMusic: Bool { library?.mediaTypes == [.album] }

    var body: some View {
        Group {
            if let library, isMusic {
                MusicLibraryView(libraryId: libraryId, name: library.name,
                                 onSelectAlbum: { onSelectMedia($0, .album) }, onSelectArtist: onSelectArtist)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        header
                        content(for: state)
                    }
                    .padding(.horizontal, 60)
                    .padding(.vertical, 48)
                }
            }
        }
        .task {
            await loadLibrary()
            guard !isMusic else { return }
            await load(reset: true)
        }
    }

    @ViewBuilder
    private func content(for state: LoadState) -> some View {
        switch state {
        case .loading:
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 30), count: 6), spacing: 30) {
                ForEach(0..<12, id: \.self) { _ in
                    SkeletonBox().aspectRatio(2.0 / 3.0, contentMode: .fit)
                }
            }
        case .failed:
            VStack(spacing: 16) {
                Text(tr("library.load_error"))
                Button(tr("common.retry")) { Task { await load(reset: true) } }
            }
        case .loaded:
            if items.isEmpty {
                Text(tr("library.empty")).foregroundStyle(.secondary)
            } else {
                ContentGrid(title: nil, items: items, onReachEnd: loadMore) { m in
                    MediaCard(imagePath: m.posterUrl, title: m.title, subtitle: m.year.map(String.init),
                              backdropPath: m.fanartUrl, mediaId: m.id, missing: m.isMissing) {
                        onSelectMedia(m.id, m.type)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var header: some View {
        HStack(spacing: 24) {
            Text(library?.name ?? "").font(.title.bold())
            Spacer()
            if let types = library?.mediaTypes, types.count > 1 {
                Picker(tr("library.type_filter"), selection: $typeFilter) {
                    Text(tr("library.type.all")).tag(MediaKind?.none)
                    ForEach(MediaKind.filterable, id: \.self) { Text(tr($0.labelKey)).tag(MediaKind?.some($0)) }
                }
                .pickerStyle(.menu)
                .onChange(of: typeFilter) { _, _ in Task { await load(reset: true) } }
            }
            Picker(tr("library.sort_by"), selection: $sortBy) {
                Text(tr("library.sort.title")).tag("title")
                Text(tr("library.sort.year")).tag("year")
                Text(tr("library.sort.added")).tag("added")
                Text(tr("library.sort.rating")).tag("rating")
            }
            .pickerStyle(.menu)
            .onChange(of: sortBy) { _, newValue in
                // Natural order per field, mirroring the web client: title
                // reads A→Z, the rest lead with the newest/best value.
                sortOrder = newValue == "title" ? "ASC" : "DESC"
                Task { await load(reset: true) }
            }
            Button(action: {
                sortOrder = sortOrder == "ASC" ? "DESC" : "ASC"
                Task { await load(reset: true) }
            }) {
                Image(systemName: sortOrder == "ASC" ? "arrow.up" : "arrow.down")
            }
            .buttonStyle(.bordered)
        }
        .focusSection()
    }

    private func loadLibrary() async {
        let libs: [Library] = (try? await APIClient.shared.get("/api/libraries/mine")) ?? []
        library = libs.first { $0.id == libraryId }
    }

    private func load(reset: Bool, page start: Int = 1) async {
        if reset {
            generation += 1
            state = .loading
            page = 1
            items = []
            fetched = 0
        }
        let gen = generation
        let (sort, order, type) = (sortBy, sortOrder, typeFilter)
        var next = reset ? 1 : start
        while true {
            var query = [
                "libraryId": String(libraryId),
                "sortBy": sort,
                "sortOrder": order,
                "page": String(next),
                "limit": String(pageSize),
            ]
            if let type { query["type"] = type.rawValue }
            do {
                let res: Paginated<Media> = try await APIClient.shared.get("/api/media", query: query)
                guard gen == generation else { return }
                let data = res.data.filter(\.type.isPlayable)
                items += data
                total = res.total
                fetched += res.data.count
                page = next
                backdrop.seed(items.first?.fanartUrl)
                if data.isEmpty, !res.data.isEmpty, fetched < total {
                    next += 1
                    continue
                }
                state = .loaded
            } catch {
                if reset, gen == generation { state = .failed }
            }
            return
        }
    }

    /// Guards synchronously (before spawning the fetch) so the handful of
    /// `onReachEnd` calls `ContentGrid` fires per near-end item in one layout
    /// pass collapse into a single page fetch.
    private func loadMore() {
        guard !isLoadingMore, fetched < total else { return }
        isLoadingMore = true
        Task {
            await load(reset: false, page: page + 1)
            isLoadingMore = false
        }
    }
}
