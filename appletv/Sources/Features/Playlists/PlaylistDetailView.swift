import SwiftUI

/// GET /api/playlists/:id + /api/playlists/:id/items -> ContentGrid, in
/// playlist (position) order. "Play all" and item taps resolve the target
/// file the same way `MediaDetailView` does — the item payload's `media`
/// carries no `files`, so a fresh GET /api/media/:id backs the lookup.
struct PlaylistDetailView: View {
    let playlistId: Int
    var onPlay: (_ mediaFileId: Int, _ mediaId: Int, _ episodeId: Int?, _ startAt: Double) -> Void

    private enum LoadState {
        case loading
        case loaded
        case failed
    }

    @State private var state: LoadState = .loading
    @State private var playlist: Playlist?
    @State private var items: [PlaylistItem] = []
    @State private var resolving = false
    @Environment(Backdrop.self) private var backdrop

    var body: some View {
        ScrollView {
            content
                .padding(.horizontal, 60)
                .padding(.vertical, 48)
        }
        .task { await load() }
    }

    @ViewBuilder
    private var content: some View {
        switch state {
        case .loading:
            ProgressView()
                .controlSize(.large)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed:
            VStack(spacing: 16) {
                Text(tr("playlists.load_error"))
                Button(tr("common.retry")) { Task { await load() } }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .loaded:
            VStack(alignment: .leading, spacing: 32) {
                header
                if items.isEmpty {
                    Text(tr("playlists.detail_empty")).foregroundStyle(.secondary)
                } else {
                    ContentGrid(title: nil, items: items) { item in
                        PosterCard(imagePath: itemImage(item), title: itemTitle(item)) {
                            Task { await play(item) }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var header: some View {
        HStack(spacing: 24) {
            Text(playlist?.name ?? "").font(.title.bold())
            if !items.isEmpty {
                Button(action: { Task { await playAll() } }) {
                    Label(tr("common.play"), systemImage: "play.fill")
                }
                .buttonStyle(.borderedProminent)
                .disabled(resolving)
            }
        }
        .focusSection()
    }

    private func itemTitle(_ item: PlaylistItem) -> String {
        guard let ep = item.episode else { return item.media.title }
        let code = ep.season.map { "S\($0.seasonNumber)E\(ep.episodeNumber)" } ?? "E\(ep.episodeNumber)"
        return "\(item.media.title) · \(code)"
    }

    private func itemImage(_ item: PlaylistItem) -> String? {
        item.episode?.stillUrl ?? item.media.posterUrl
    }

    private func load() async {
        state = .loading
        async let playlistTask: Playlist = APIClient.shared.get("/api/playlists/\(playlistId)")
        async let itemsTask: [PlaylistItem] = APIClient.shared.get("/api/playlists/\(playlistId)/items")
        do {
            let (p, i) = try await (playlistTask, itemsTask)
            playlist = p
            items = i
            state = .loaded
            backdrop.seed(i.first?.media.fanartUrl)
        } catch {
            state = .failed
        }
    }

    /// Play the first unwatched item, else the first — playlist (position) order.
    // ponytail: launches only the starting item — PlayerView (P5) has no
    // cross-media queue to auto-advance into the next playlist item yet.
    // Add a queue (mirroring the web PlaybackQueueService) if that's needed.
    private func playAll() async {
        guard !items.isEmpty else { return }
        let target = items.first(where: { !$0.watched }) ?? items[0]
        await play(target)
    }

    /// Resolve the file id via a fresh GET /media/:id (the item payload has no
    /// `files`) and hand off to the player, exactly like MediaDetailView.
    private func play(_ item: PlaylistItem) async {
        guard !resolving else { return }
        resolving = true
        defer { resolving = false }
        guard let media: Media = try? await APIClient.shared.get("/api/media/\(item.media.id)"),
              let fileId = media.fileId(episodeId: item.episode?.id) else {
            return // ponytail: silent no-op — no toast/error-banner system on tvOS yet
        }
        onPlay(fileId, item.media.id, item.episode?.id, 0)
    }
}
