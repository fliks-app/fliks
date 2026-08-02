import SwiftUI

/// Native tvOS search: system `.searchable` field + a type filter, debounced
/// ~250ms against GET /api/media?q=&type=&page=&limit= -> Paginated<Media>.
struct SearchView: View {
    var onSelectMedia: (Int) -> Void

    @State private var query = ""
    @State private var typeFilter: String?
    @State private var results: [Media] = []
    @State private var total = 0
    @State private var page = 1
    @State private var loading = false
    @State private var loadError = false
    @State private var isLoadingMore = false
    @State private var queryTask: Task<Void, Never>?
    @Environment(Backdrop.self) private var backdrop

    private let pageSize = 30

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                typePicker
                content
            }
            .padding(.horizontal, 60)
            .padding(.vertical, 40)
        }
        .searchable(text: $query, prompt: tr("search.prompt"))
        .onChange(of: query) { _, _ in scheduleSearch() }
        .onChange(of: typeFilter) { _, _ in scheduleSearch() }
    }

    @ViewBuilder private var typePicker: some View {
        Picker(tr("library.type_filter"), selection: $typeFilter) {
            Text(tr("library.type.all")).tag(String?.none)
            Text(tr("library.type.movie")).tag(String?.some("movie"))
            Text(tr("library.type.series")).tag(String?.some("series"))
        }
        .pickerStyle(.menu)
        .focusSection()
    }

    @ViewBuilder private var content: some View {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            Text(tr("search.hint"))
                .font(.title3)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .padding(.top, 100)
        } else if loading && results.isEmpty {
            ProgressView()
                .controlSize(.large)
                .frame(maxWidth: .infinity)
                .padding(.top, 100)
        } else if loadError && results.isEmpty {
            VStack(spacing: 16) {
                Text(tr("search.load_error"))
                Button(tr("common.retry")) { runNow() }
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 100)
        } else if results.isEmpty {
            Text(tr("search.empty"))
                .font(.title3)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .padding(.top, 100)
        } else {
            ContentGrid(title: nil, items: results, onReachEnd: loadMore) { media in
                PosterCard(imagePath: media.posterUrl, title: media.title, mediaId: media.id) {
                    onSelectMedia(media.id)
                }
            }
        }
    }

    private func scheduleSearch() {
        queryTask?.cancel()
        guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            results = []
            total = 0
            loading = false
            loadError = false
            return
        }
        queryTask = Task {
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard !Task.isCancelled else { return }
            await runSearch(page: 1)
        }
    }

    /// Bypasses the debounce (retry button).
    private func runNow() {
        queryTask?.cancel()
        Task { await runSearch(page: 1) }
    }

    private func runSearch(page: Int) async {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let type = typeFilter
        guard !q.isEmpty else { return }
        if page == 1 { loading = true }
        defer { loading = false }
        var params = ["q": q, "page": String(page), "limit": String(pageSize)]
        if let type { params["type"] = type }
        do {
            let res: Paginated<Media> = try await APIClient.shared.get("/api/media", query: params)
            // Drop a stale response superseded by a newer query/filter change.
            guard q == query.trimmingCharacters(in: .whitespacesAndNewlines), type == typeFilter else { return }
            results = page == 1 ? res.data : results + res.data
            total = res.total
            self.page = page
            loadError = false
            backdrop.seed(res.data.first?.fanartUrl)
        } catch {
            guard q == query.trimmingCharacters(in: .whitespacesAndNewlines), type == typeFilter else { return }
            if page == 1 { results = []; loadError = true }
        }
    }

    private func loadMore() {
        guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !isLoadingMore, results.count < total else { return }
        isLoadingMore = true
        Task {
            await runSearch(page: page + 1)
            isLoadingMore = false
        }
    }
}
