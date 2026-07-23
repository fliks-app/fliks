import SwiftUI

/// GET /api/media?libraryId=&type=&sortBy=&sortOrder=&page=&limit= -> Paginated<Media>.
/// 6-col portrait grid (ContentGrid) with sort + type filter and infinite
/// scroll via `onReachEnd`.
struct LibraryView: View {
    let libraryId: Int
    var onSelectMedia: (Int) -> Void

    private enum LoadState {
        case loading
        case loaded
        case failed
    }

    @State private var state: LoadState = .loading
    @State private var items: [Media] = []
    @State private var total = 0
    @State private var page = 1
    @State private var isLoadingMore = false
    @State private var sortBy = "title"
    @State private var sortOrder = "ASC"
    @State private var typeFilter: String?
    @State private var library: Library?
    @Environment(Backdrop.self) private var backdrop

    private let pageSize = 60

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                header
                content(for: state)
            }
            .padding(.horizontal, 60)
            .padding(.vertical, 48)
        }
        .task {
            await loadLibrary()
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
                              backdropPath: m.fanartUrl) {
                        onSelectMedia(m.id)
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
                    Text(tr("library.type.all")).tag(String?.none)
                    Text(tr("library.type.movie")).tag(String?.some("movie"))
                    Text(tr("library.type.series")).tag(String?.some("series"))
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

    private func load(reset: Bool) async {
        if reset {
            state = .loading
            page = 1
            items = []
        }
        var query = [
            "libraryId": String(libraryId),
            "sortBy": sortBy,
            "sortOrder": sortOrder,
            "page": String(page),
            "limit": String(pageSize),
        ]
        if let typeFilter { query["type"] = typeFilter }
        do {
            let res: Paginated<Media> = try await APIClient.shared.get("/api/media", query: query)
            items = reset ? res.data : items + res.data
            total = res.total
            state = .loaded
            backdrop.seed(res.data.first?.fanartUrl)
        } catch {
            if reset { state = .failed }
        }
    }

    /// Guards synchronously (before spawning the fetch) so the handful of
    /// `onReachEnd` calls `ContentGrid` fires per near-end item in one layout
    /// pass collapse into a single page fetch.
    private func loadMore() {
        guard !isLoadingMore, items.count < total else { return }
        isLoadingMore = true
        page += 1
        Task {
            await load(reset: false)
            isLoadingMore = false
        }
    }
}
