import SwiftUI

/// An artist: portrait, biography and the discography by release type.
struct ArtistView: View {
    let personId: Int
    var onSelectAlbum: (Int) -> Void

    private enum LoadState { case loading, loaded(Discography), failed }

    @State private var state: LoadState = .loading
    @Environment(Backdrop.self) private var backdrop

    var body: some View {
        Group {
            switch state {
            case .loading:
                ProgressView().controlSize(.large).frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed:
                VStack(spacing: 20) {
                    Text(tr("music.load_failed")).font(.title3)
                    Button(tr("common.retry")) { Task { await load() } }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .loaded(let d):
                content(d)
            }
        }
        .task { await load() }
    }

    private func content(_ d: Discography) -> some View {
        let groups = d.groups()
        return ScrollView {
            VStack(alignment: .leading, spacing: 36) {
                HStack(alignment: .top, spacing: 44) {
                    Group {
                        if let image = d.artist.imageUrl {
                            PosterImage(path: image, size: .medium)
                        } else {
                            ZStack {
                                Rectangle().fill(Color.white.opacity(0.12))
                                Image(systemName: "music.mic").font(.system(size: 80)).foregroundStyle(.white.opacity(0.4))
                            }
                        }
                    }
                    .frame(width: 260, height: 260)
                    .clipShape(Circle())
                    VStack(alignment: .leading, spacing: 16) {
                        Text(d.artist.name).font(.system(size: 52, weight: .bold)).lineLimit(2)
                        if let bio = d.artist.biography, !bio.isEmpty {
                            Text(bio).font(.body).foregroundStyle(.secondary).lineLimit(4).frame(maxWidth: 1000, alignment: .leading)
                        }
                    }
                }
                if groups.isEmpty {
                    Text(tr("music.no_albums")).foregroundStyle(.secondary)
                }
                ForEach(groups) { group in
                    Rail(title: tr(group.key), items: group.albums) { a in
                        AlbumTile(imagePath: a.posterUrl, title: a.title, subtitle: a.year.map(String.init), dimmed: a.mediaId == nil) {
                            if let id = a.mediaId { onSelectAlbum(id) }
                        }
                        .disabled(a.mediaId == nil)
                    }
                }
            }
            .padding(.horizontal, 60)
            .padding(.vertical, 48)
        }
    }

    private func load() async {
        do {
            let d = try await MusicAPI.discography(personId)
            state = .loaded(d)
            backdrop.url = d.artist.imageUrl ?? d.albums.first { $0.owned }?.posterUrl
        } catch {
            state = .failed
        }
    }
}
