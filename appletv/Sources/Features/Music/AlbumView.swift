import SwiftUI

/// An album: editions, discs, tracks and credits. A tap on a track plays the album from it.
struct AlbumView: View {
    let mediaId: Int
    var onSelectArtist: (Int) -> Void

    private enum LoadState { case loading, loaded(AlbumPage), failed }

    @State private var state: LoadState = .loading
    @State private var tracks: [Track] = []
    @State private var editionId: Int?
    @Environment(Backdrop.self) private var backdrop
    @Environment(PlaylistPicker.self) private var picker
    @Environment(PartyService.self) private var party

    private let player = MusicPlayer.shared

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
            case .loaded(let page):
                content(page)
            }
        }
        .task { await load() }
    }

    private func content(_ page: AlbumPage) -> some View {
        let edition = page.album.edition(editionId)
        let discs = Disc.group(tracks, edition: edition?.id)
        return ScrollView {
            VStack(alignment: .leading, spacing: 36) {
                header(page, edition)
                ForEach(discs) { disc in
                    VStack(alignment: .leading, spacing: 10) {
                        if discs.count > 1 {
                            Text([trp("music.disc", ["n": String(disc.number)]), disc.title].compactMap { $0 }.joined(separator: " · "))
                                .font(.title3.bold())
                        }
                        ForEach(disc.tracks) { t in line(t, page, edition) }
                    }
                    .focusSection()
                }
                credits()
            }
            .padding(.horizontal, 60)
            .padding(.vertical, 48)
        }
        .onAppear { backdrop.url = page.fanartUrl ?? page.posterUrl }
    }

    private func header(_ page: AlbumPage, _ edition: AlbumEdition?) -> some View {
        HStack(alignment: .top, spacing: 48) {
            PosterImage(path: edition?.coverUrl ?? page.posterUrl, size: .full)
                .frame(width: 380, height: 380)
                .clipShape(RoundedRectangle(cornerRadius: 12))
            VStack(alignment: .leading, spacing: 18) {
                Text(page.title).font(.system(size: 48, weight: .bold)).lineLimit(2)
                artistButtons(page)
                Text(facts(page, edition)).font(.callout).foregroundStyle(.secondary)
                if let overview = page.overview, !overview.isEmpty {
                    Text(overview).font(.body).lineLimit(3).frame(maxWidth: 900, alignment: .leading)
                }
                actions(page, edition)
            }
        }
    }

    @ViewBuilder private func artistButtons(_ page: AlbumPage) -> some View {
        let artists = page.album.artists
        if artists.count == 1, let a = artists.first {
            Button { onSelectArtist(a.id) } label: { Label(a.creditedName ?? a.name, systemImage: "music.mic") }
                .buttonStyle(.bordered)
        } else if artists.count > 1 {
            HStack(spacing: 16) {
                ForEach(artists.prefix(3), id: \.id) { a in
                    Button { onSelectArtist(a.id) } label: { Text(a.creditedName ?? a.name).lineLimit(1) }
                        .buttonStyle(.bordered)
                }
            }
        }
    }

    private func actions(_ page: AlbumPage, _ edition: AlbumEdition?) -> some View {
        let queue = playable(page, edition)
        return HStack(spacing: 24) {
            Button { player.play(queue) } label: { Label(tr("music.play"), systemImage: "play.fill") }
                .buttonStyle(.borderedProminent)
                .disabled(queue.isEmpty)
            Button { player.play(queue, shuffle: true) } label: { Label(tr("music.shuffle"), systemImage: "shuffle") }
                .buttonStyle(.bordered)
                .disabled(queue.isEmpty)
            if party.canCreate, !queue.isEmpty {
                Button {
                    party.openCreate(PartyCreateTarget(name: page.title, items: queue.map {
                        PartyCreateItem(mediaId: $0.mediaId, itemId: $0.itemId)
                    }))
                } label: { Label(tr("party.watch_together"), systemImage: "person.2.fill") }
                    .buttonStyle(.bordered)
            }
            if page.album.editions.count > 1 {
                Picker(tr("music.editions"), selection: Binding(get: { edition?.id ?? 0 }, set: { editionId = $0 })) {
                    ForEach(page.album.editions) { e in Text(editionLabel(e)).tag(e.id) }
                }
                .pickerStyle(.menu)
            }
        }
        .focusSection()
    }

    private func line(_ t: Track, _ page: AlbumPage, _ edition: AlbumEdition?) -> some View {
        let queue = playable(page, edition)
        let albumArtists = page.album.artists.map(\.name).joined(separator: ", ")
        let own = MusicFormat.artistLine(t.artists)
        return TrackLine(number: t.trackNumber.map(String.init) ?? t.label, title: t.title,
                         subtitle: own == albumArtists ? nil : own,
                         duration: MusicFormat.duration(t.durationSeconds), explicit: t.explicit, favourite: t.favourite,
                         playing: player.current?.itemId == t.itemId, disabled: !t.playable,
                         actions: actions(t, page, edition)) {
            player.play(queue, from: queue.firstIndex { $0.itemId == t.itemId } ?? 0)
        }
    }

    private func actions(_ t: Track, _ page: AlbumPage, _ edition: AlbumEdition?) -> TrackActions {
        let item = QueueTrack(track: t, album: page, edition: edition)
        return TrackActions(
            favourite: t.favourite, rating: t.rating,
            onFavourite: { toggleFavourite(t, page) },
            onRate: { rate(t, $0) },
            onPlaylist: { picker.open(mediaId: page.id, itemId: t.itemId) },
            onPlayNext: { player.addNext([item]) },
            onQueue: { player.addLast([item]) })
    }

    @ViewBuilder private func credits() -> some View {
        let order = ["composer", "lyricist", "conductor", "orchestra", "ensemble", "performer"]
        let all = tracks.flatMap(\.credits)
        let lines = order.compactMap { role -> (String, String)? in
            var seen = Set<String>()
            let names = all.filter { $0.role == role }.map(\.name).filter { seen.insert($0).inserted }
            return names.isEmpty ? nil : (tr("music.role_\(role)"), names.joined(separator: ", "))
        }
        if !lines.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text(tr("music.credits")).font(.title3.bold())
                ForEach(lines, id: \.0) { role, names in
                    Text("\(role): \(names)").font(.callout).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: 1200, alignment: .leading)
        }
    }

    // MARK: - Data

    private func playable(_ page: AlbumPage, _ edition: AlbumEdition?) -> [QueueTrack] {
        tracks.filter { $0.playable && (edition == nil || $0.editionId == edition?.id) }
            .map { QueueTrack(track: $0, album: page, edition: edition) }
    }

    private func facts(_ page: AlbumPage, _ edition: AlbumEdition?) -> String {
        var parts: [String] = []
        if let y = page.year ?? page.album.firstReleaseDate.flatMap({ Int($0.prefix(4)) }) { parts.append(String(y)) }
        if let type = page.album.primaryType { parts.append(type) }
        let list = tracks.filter { edition == nil || $0.editionId == edition?.id }
        parts.append(trp(list.count == 1 ? "music.track_count_one" : "music.track_count_other", ["count": String(list.count)]))
        let seconds = list.compactMap(\.durationSeconds).reduce(0, +)
        if seconds > 0 { parts.append(MusicFormat.duration(seconds)) }
        return parts.joined(separator: " · ")
    }

    private func editionLabel(_ e: AlbumEdition) -> String {
        [e.title, e.country, e.media, e.releaseDate.map { String($0.prefix(4)) }].compactMap { $0 }.filter { !$0.isEmpty }
            .joined(separator: " · ")
    }

    private func load() async {
        do {
            let page = try await MusicAPI.albumPage(mediaId)
            tracks = page.album.tracks
            state = .loaded(page)
            backdrop.url = page.fanartUrl ?? page.posterUrl
        } catch {
            state = .failed
        }
    }

    private func toggleFavourite(_ t: Track, _ page: AlbumPage) {
        guard let i = tracks.firstIndex(where: { $0.itemId == t.itemId }) else { return }
        let on = !tracks[i].favourite
        tracks[i].favourite = on
        Task { if (try? await MusicAPI.setFavourite(on, mediaId: page.id, itemId: t.itemId)) == nil { tracks[i].favourite = !on } }
    }

    private func rate(_ t: Track, _ rating: Int?) {
        guard let i = tracks.firstIndex(where: { $0.itemId == t.itemId }) else { return }
        let before = tracks[i].rating
        tracks[i].rating = rating
        Task { if (try? await MusicAPI.rate(rating, itemId: t.itemId)) == nil { tracks[i].rating = before } }
    }
}
