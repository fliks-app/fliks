import SwiftUI

/// GET /api/playlists -> grid (first poster as art); tap -> Route.playlistDetail(id:).
struct PlaylistsView: View {
    var onSelectPlaylist: (Int) -> Void

    private enum LoadState {
        case loading
        case loaded
        case failed
    }

    @State private var state: LoadState = .loading
    @State private var playlists: [Playlist] = []

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
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 30), count: 6), spacing: 30) {
                ForEach(0..<6, id: \.self) { _ in
                    SkeletonBox().aspectRatio(2.0 / 3.0, contentMode: .fit)
                }
            }
        case .failed:
            VStack(spacing: 16) {
                Text(tr("playlists.load_error"))
                Button(tr("common.retry")) { Task { await load() } }
            }
        case .loaded:
            if playlists.isEmpty {
                Text(tr("playlists.empty")).foregroundStyle(.secondary)
            } else {
                ContentGrid(title: nil, items: playlists) { playlist in
                    PosterCard(imagePath: playlist.posters.first, title: playlist.name) {
                        onSelectPlaylist(playlist.id)
                    }
                }
            }
        }
    }

    private func load() async {
        state = .loading
        do {
            playlists = try await APIClient.shared.get("/api/playlists")
            state = .loaded
        } catch {
            state = .failed
        }
    }
}
