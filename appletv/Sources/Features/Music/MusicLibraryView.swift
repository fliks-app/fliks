import SwiftUI

/// The music library: albums (with the recently played), artists and tracks.
struct MusicLibraryView: View {
    let libraryId: Int
    let name: String
    var onSelectAlbum: (Int) -> Void
    var onSelectArtist: (Int) -> Void

    private enum Tab: String, CaseIterable {
        case albums, artists, tracks
        var labelKey: String { "music.tab_\(rawValue)" }
    }

    @State private var tab: Tab = .albums
    @Environment(Backdrop.self) private var backdrop

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                HStack(spacing: 24) {
                    Text(name).font(.title.bold())
                    Spacer()
                    Picker("", selection: $tab) {
                        ForEach(Tab.allCases, id: \.self) { Text(tr($0.labelKey)).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .frame(maxWidth: 800)
                }
                .focusSection()
                switch tab {
                case .albums: AlbumsTab(libraryId: libraryId, onSelect: onSelectAlbum)
                case .artists: ArtistsTab(libraryId: libraryId, onSelect: onSelectArtist)
                case .tracks: TracksTab(libraryId: libraryId, onSelect: onSelectAlbum)
                }
            }
            .padding(.horizontal, 60)
            .padding(.vertical, 48)
        }
    }
}

private struct AlbumsTab: View {
    let libraryId: Int
    var onSelect: (Int) -> Void

    @State private var recent: [AlbumCard] = []
    @State private var albums: [AlbumCard] = []
    @State private var total = 0
    @State private var page = 1
    @State private var loading = true
    @State private var failed = false
    @State private var loadingMore = false
    @State private var sortBy = "title"
    @State private var sortOrder = "ASC"
    @State private var generation = 0
    @Environment(Backdrop.self) private var backdrop

    private let pageSize = 60

    var body: some View {
        VStack(alignment: .leading, spacing: 28) {
            if !recent.isEmpty {
                Rail(title: tr("music.recently_played"), items: recent) { tile($0) }
            }
            sortBar
            if loading && albums.isEmpty {
                ProgressView().controlSize(.large).frame(maxWidth: .infinity).padding(.top, 60)
            } else if failed && albums.isEmpty {
                VStack(spacing: 16) {
                    Text(tr("music.load_failed"))
                    Button(tr("common.retry")) { Task { await load(reset: true) } }
                }.frame(maxWidth: .infinity)
            } else if albums.isEmpty {
                Text(tr("music.no_albums")).foregroundStyle(.secondary)
            } else {
                ContentGrid(title: nil, items: albums, columns: 6, onReachEnd: loadMore) { tile($0) }
            }
        }
        .task {
            recent = await MusicAPI.recentlyPlayed()
            await load(reset: true)
        }
    }

    private var sortBar: some View {
        HStack(spacing: 24) {
            Spacer()
            Picker(tr("music.sort"), selection: $sortBy) {
                Text(tr("library.sort.title")).tag("title")
                Text(tr("library.sort.year")).tag("year")
                Text(tr("library.sort.added")).tag("added")
                Text(tr("library.sort.rating")).tag("rating")
            }
            .pickerStyle(.menu)
            .onChange(of: sortBy) { _, v in
                sortOrder = v == "title" ? "ASC" : "DESC"
                Task { await load(reset: true) }
            }
            Button {
                sortOrder = sortOrder == "ASC" ? "DESC" : "ASC"
                Task { await load(reset: true) }
            } label: { Image(systemName: sortOrder == "ASC" ? "arrow.up" : "arrow.down") }
                .buttonStyle(.bordered)
        }
        .focusSection()
    }

    private func tile(_ a: AlbumCard) -> some View {
        AlbumTile(imagePath: a.posterUrl, title: a.title, subtitle: [a.artistLine, a.year.map(String.init)].compactMap { $0 }.joined(separator: " · ")) {
            onSelect(a.id)
        }
    }

    private func load(reset: Bool) async {
        if reset { generation += 1; albums = []; page = 1; total = 0; loading = true }
        let gen = generation
        let next = reset ? 1 : page + 1
        do {
            let res = try await MusicAPI.albums(libraryId: libraryId, sortBy: sortBy, sortOrder: sortOrder, page: next, limit: pageSize)
            guard gen == generation else { return }
            albums += res.data
            total = res.total
            page = next
            failed = false
            backdrop.seed(albums.first?.fanartUrl ?? albums.first?.posterUrl)
        } catch {
            if gen == generation { failed = true }
        }
        if gen == generation { loading = false }
    }

    private func loadMore() {
        guard !loadingMore, albums.count < total else { return }
        loadingMore = true
        Task { await load(reset: false); loadingMore = false }
    }
}

private struct ArtistsTab: View {
    let libraryId: Int
    var onSelect: (Int) -> Void

    @State private var artists: [MusicPersonRow] = []
    @State private var page = 1
    @State private var more = true
    @State private var loading = true
    @State private var failed = false
    @State private var loadingMore = false

    private let pageSize = 60

    var body: some View {
        Group {
            if loading && artists.isEmpty {
                ProgressView().controlSize(.large).frame(maxWidth: .infinity).padding(.top, 60)
            } else if failed && artists.isEmpty {
                VStack(spacing: 16) {
                    Text(tr("music.load_failed"))
                    Button(tr("common.retry")) { Task { await load(reset: true) } }
                }.frame(maxWidth: .infinity)
            } else if artists.isEmpty {
                Text(tr("music.no_artists")).foregroundStyle(.secondary)
            } else {
                ContentGrid(title: nil, items: artists, columns: 7, onReachEnd: loadMore) { a in
                    ArtistTile(imagePath: a.avatarUrl, name: a.name,
                               caption: trp(a.albumCount == 1 ? "music.album_count_one" : "music.album_count_other", ["count": String(a.albumCount)])) {
                        onSelect(a.id)
                    }
                }
            }
        }
        .task { await load(reset: true) }
    }

    private func load(reset: Bool) async {
        if reset { artists = []; page = 1; more = true; loading = true }
        let next = reset ? 1 : page + 1
        do {
            let rows = try await MusicAPI.artists(libraryId: libraryId, page: next, limit: pageSize)
            artists += rows
            more = rows.count == pageSize
            page = next
            failed = false
        } catch { failed = true }
        loading = false
    }

    private func loadMore() {
        guard !loadingMore, more else { return }
        loadingMore = true
        Task { await load(reset: false); loadingMore = false }
    }
}

private struct TracksTab: View {
    let libraryId: Int
    var onSelect: (Int) -> Void

    @State private var rows: [TrackRow] = []
    @State private var page = 1
    @State private var more = true
    @State private var loading = true
    @State private var failed = false
    @State private var loadingMore = false
    @State private var sortBy = "title"
    @State private var sortOrder = "asc"
    @State private var favouritesOnly = false
    @State private var generation = 0
    @Environment(PlaylistPicker.self) private var picker

    private let pageSize = 50
    private let player = MusicPlayer.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(spacing: 24) {
                Spacer()
                Picker(tr("music.filter"), selection: $favouritesOnly) {
                    Text(tr("music.filter_all")).tag(false)
                    Text(tr("music.filter_favourites")).tag(true)
                }
                .pickerStyle(.menu)
                Picker(tr("music.sort"), selection: $sortBy) {
                    Text(tr("music.sort_title")).tag("title")
                    Text(tr("music.sort_album")).tag("album")
                    Text(tr("music.sort_added")).tag("added")
                    Text(tr("music.sort_played")).tag("played")
                    Text(tr("music.sort_rating")).tag("rating")
                }
                .pickerStyle(.menu)
            }
            .focusSection()
            if loading && rows.isEmpty {
                ProgressView().controlSize(.large).frame(maxWidth: .infinity).padding(.top, 60)
            } else if failed && rows.isEmpty {
                VStack(spacing: 16) {
                    Text(tr("music.load_failed"))
                    Button(tr("common.retry")) { Task { await load(reset: true) } }
                }.frame(maxWidth: .infinity)
            } else if rows.isEmpty {
                Text(tr("music.no_tracks")).foregroundStyle(.secondary)
            } else {
                LazyVStack(spacing: 10) {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { i, row in
                        TrackLine(imagePath: row.posterUrl, title: row.title,
                                  subtitle: [MusicFormat.artistLine(row.artists), row.albumTitle].filter { !$0.isEmpty }.joined(separator: " · "),
                                  duration: MusicFormat.duration(row.durationSeconds), favourite: row.favourite,
                                  playing: player.current?.itemId == row.itemId,
                                  actions: actions(for: row, at: i)) {
                            player.play(rows.map(QueueTrack.init(row:)), from: i)
                        }
                        .onAppear { if i >= rows.count - 5 { loadMore() } }
                    }
                }
                .focusSection()
            }
        }
        .task { await load(reset: true) }
        .onChange(of: sortBy) { _, v in
            sortOrder = v == "title" || v == "album" ? "asc" : "desc"
            Task { await load(reset: true) }
        }
        .onChange(of: favouritesOnly) { _, _ in Task { await load(reset: true) } }
    }

    private func actions(for row: TrackRow, at i: Int) -> TrackActions {
        TrackActions(
            favourite: row.favourite, rating: row.rating,
            onFavourite: {
                let on = !row.favourite
                rows[i].favourite = on
                Task { if (try? await MusicAPI.setFavourite(on, mediaId: row.mediaId, itemId: row.itemId)) == nil { rows[i].favourite = !on } }
            },
            onRate: { rating in
                let before = rows[i].rating
                rows[i].rating = rating
                Task { if (try? await MusicAPI.rate(rating, itemId: row.itemId)) == nil { rows[i].rating = before } }
            },
            onPlaylist: { picker.open(mediaId: row.mediaId, itemId: row.itemId) },
            onPlayNext: { player.addNext([QueueTrack(row: row)]) },
            onQueue: { player.addLast([QueueTrack(row: row)]) })
    }

    private func load(reset: Bool) async {
        if reset { generation += 1; rows = []; page = 1; more = true; loading = true }
        let gen = generation
        let next = reset ? 1 : page + 1
        do {
            let list = try await MusicAPI.tracks(libraryId: libraryId, favourite: favouritesOnly, sortBy: sortBy,
                                                 sortOrder: sortOrder, page: next, limit: pageSize)
            guard gen == generation else { return }
            rows += list
            more = list.count == pageSize
            page = next
            failed = false
        } catch { if gen == generation { failed = true } }
        if gen == generation { loading = false }
    }

    private func loadMore() {
        guard !loadingMore, more else { return }
        loadingMore = true
        Task { await load(reset: false); loadingMore = false }
    }
}

/// Albums, artists and tracks that match a search.
struct MusicSearchSections: View {
    let query: String
    let genericEmpty: Bool
    var onSelectAlbum: (Int) -> Void
    var onSelectArtist: (Int) -> Void

    @State private var albums: [AlbumCard] = []
    @State private var artists: [MusicPersonRow] = []
    @State private var tracks: [TrackRow] = []
    @State private var done = false

    private let player = MusicPlayer.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            if !albums.isEmpty {
                Rail(title: tr("music.section_albums"), items: albums) { a in
                    AlbumTile(imagePath: a.posterUrl, title: a.title, subtitle: a.artistLine) { onSelectAlbum(a.id) }
                }
            }
            if !artists.isEmpty {
                Rail(title: tr("music.section_artists"), items: artists) { a in
                    ArtistTile(imagePath: a.avatarUrl, name: a.name) { onSelectArtist(a.id) }
                }
            }
            if !tracks.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text(tr("music.tab_tracks")).font(.title2.bold())
                    ForEach(Array(tracks.enumerated()), id: \.element.id) { i, row in
                        TrackLine(imagePath: row.posterUrl, title: row.title,
                                  subtitle: [MusicFormat.artistLine(row.artists), row.albumTitle].filter { !$0.isEmpty }.joined(separator: " · "),
                                  duration: MusicFormat.duration(row.durationSeconds)) {
                            player.play(tracks.map(QueueTrack.init(row:)), from: i)
                        }
                    }
                }
                .focusSection()
            }
            if done, genericEmpty, albums.isEmpty, artists.isEmpty, tracks.isEmpty, !query.isEmpty {
                Text(tr("search.empty")).font(.title3).foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(.top, 100)
            }
        }
        .task(id: query) {
            done = false
            guard !query.isEmpty else { albums = []; artists = []; tracks = []; return }
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled else { return }
            async let a = try? MusicAPI.searchAlbums(query, limit: 12)
            async let p = try? MusicAPI.artists(q: query, limit: 12)
            async let t = try? MusicAPI.tracks(q: query, limit: 8)
            let (ra, rp, rt) = await (a, p, t)
            guard !Task.isCancelled else { return }
            albums = ra ?? []; artists = rp ?? []; tracks = rt ?? []
            done = true
        }
    }
}
