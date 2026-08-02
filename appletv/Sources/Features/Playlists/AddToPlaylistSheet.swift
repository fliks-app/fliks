import SwiftUI

/// Picks the playlist a media or episode is added to. Adding an item is the
/// only action here — creating a playlist stays on the web client.
struct AddToPlaylistSheet: View {
    let target: PlaylistPicker.Target
    var onDone: () -> Void

    @State private var playlists: [Playlist] = []
    @State private var loading = true
    @State private var failed = false
    @State private var busyId: Int?

    var body: some View {
        VStack(spacing: 28) {
            Text(tr("playlists.add_to_playlist_title")).font(.title.bold())

            if loading {
                ProgressView()
            } else if failed {
                VStack(spacing: 16) {
                    Text(tr("playlists.load_error"))
                    Button(tr("common.retry")) { Task { await load() } }
                }
            } else if playlists.isEmpty {
                Text(tr("playlists.empty")).foregroundStyle(.secondary)
            } else {
                // Rows grow when focused: the scroller keeps room around them
                // and doesn't clip what overflows.
                ScrollView {
                    VStack(spacing: 16) {
                        ForEach(playlists) { playlist in
                            Button { Task { await add(to: playlist) } } label: {
                                HStack {
                                    Text(playlist.name)
                                    Spacer()
                                    if busyId == playlist.id {
                                        ProgressView()
                                    } else {
                                        Text(String(playlist.itemCount)).foregroundStyle(.secondary)
                                    }
                                }
                                .frame(maxWidth: .infinity)
                            }
                        }
                    }
                    .padding(.horizontal, 24)
                    .padding(.vertical, 20)
                }
                .scrollClipDisabled()
                .frame(maxHeight: 520)
            }

            Button(tr("common.cancel"), action: onDone)
        }
        .padding(60)
        .frame(maxWidth: 800)
        .focusSection()
        .task { await load() }
    }

    private func load() async {
        loading = true
        failed = false
        do {
            playlists = try await APIClient.shared.get("/api/playlists")
        } catch {
            failed = true
        }
        loading = false
    }

    private func add(to playlist: Playlist) async {
        struct Body: Encodable { let mediaId: Int?; let episodeId: Int? }
        busyId = playlist.id
        let body = target.episodeId == nil
            ? Body(mediaId: target.mediaId, episodeId: nil)
            : Body(mediaId: nil, episodeId: target.episodeId)
        try? await APIClient.shared.post("/api/playlists/\(playlist.id)/items", body: body)
        busyId = nil
        onDone()
    }
}
