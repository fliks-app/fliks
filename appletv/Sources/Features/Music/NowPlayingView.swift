import SwiftUI

/// Full-screen Now Playing: cover, lyrics or queue, seek bar and a row of round transport buttons.
struct NowPlayingView: View {
    var onClose: () -> Void
    var onSelectAlbum: (Int) -> Void
    var onSelectArtist: (Int) -> Void

    @State private var player = MusicPlayer.shared
    @State private var party = PartyService.shared
    @State private var favourite: Bool?
    /// The current track's album, for its favourite flag and artist ids.
    @State private var page: AlbumPage?
    @State private var lyrics: StructuredLyrics?
    @State private var showLyrics = true
    @State private var showKaraoke = false
    @State private var karaokeReady = false
    @State private var hasCdg = false
    @FocusState private var focus: Control?
    @Environment(Backdrop.self) private var backdrop
    @Environment(PlaylistPicker.self) private var picker

    private enum Control: Hashable { case play, seek }

    var body: some View {
        Group {
            if let track = player.current {
                content(track)
            } else {
                Text(tr("music.nothing_playing")).font(.title3).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .onAppear { focus = .play; player.nowPlayingOpen = true }
        .onDisappear { player.nowPlayingOpen = false }
        .fullScreenCover(isPresented: $showKaraoke) {
            if let id = player.current?.itemId { KaraokeView(itemId: id, lyrics: lyrics) { showKaraoke = false } }
        }
        .task { karaokeReady = await KaraokeAPI.status()?.ready == true }
        .task(id: player.current?.itemId) {
            hasCdg = false
            if let id = player.current?.itemId { hasCdg = await KaraokeAPI.state(itemId: id)?.cdg == true }
        }
        .overlay(alignment: .top) {
            if let notice = player.notice {
                Text(notice).padding(.horizontal, 28).padding(.vertical, 14).background(.thinMaterial, in: Capsule()).padding(.top, 30)
            }
        }
    }

    private func content(_ t: QueueTrack) -> some View {
        VStack(spacing: 0) {
            VStack(spacing: 4) {
                Text(tr("music_player.playing_from_album")).font(.callout).foregroundStyle(.secondary)
                Text(t.albumTitle).font(.headline).lineLimit(1)
            }
            .padding(.bottom, 24)
            HStack(alignment: .top, spacing: 72) {
                trackColumn(t)
                sidePane
            }
            Spacer(minLength: 16)
            seekBar
            transport(t)
                .padding(.top, 10)
        }
        .padding(.horizontal, 77)
        .padding(.vertical, 20)
        .ignoresSafeArea(edges: .horizontal)
        .onAppear { backdrop.url = t.coverUrl }
        .onChange(of: t.uid) { _, _ in favourite = nil; backdrop.url = t.coverUrl }
        .task(id: t.itemId) {
            lyrics = nil
            lyrics = await LyricsAPI.main(itemId: t.itemId)
        }
        .task(id: t.mediaId) {
            page = nil
            page = try? await MusicAPI.albumPage(t.mediaId)
        }
    }

    private func pageTrack(_ t: QueueTrack) -> Track? {
        page?.id == t.mediaId ? page?.album.tracks.first { $0.itemId == t.itemId } : nil
    }

    /// The track's credited artists, else the album's.
    private func artists(_ t: QueueTrack) -> [AlbumArtist] {
        guard let page, page.id == t.mediaId else { return [] }
        let credited = pageTrack(t)?.artists.compactMap { a in
            a.id.map { AlbumArtist(id: $0, name: a.name, creditedName: a.creditedName, joinPhrase: nil) }
        } ?? []
        return credited.isEmpty ? page.album.artists : credited
    }

    private func trackColumn(_ t: QueueTrack) -> some View {
        let liked = favourite ?? pageTrack(t)?.favourite ?? false
        return VStack(alignment: .leading, spacing: 18) {
            PosterImage(path: t.coverUrl, size: .full)
                .frame(width: 520, height: 520)
                .clipShape(RoundedRectangle(cornerRadius: 16))
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(t.title).font(.system(size: 34, weight: .semibold)).lineLimit(1)
                    Text(t.artists).font(.system(size: 28)).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 0)
                RoundButton(symbol: "text.badge.plus", size: 64, label: tr("playlists.add_to_playlist_title")) {
                    picker.open(mediaId: t.mediaId, itemId: t.itemId)
                }
                RoundButton(symbol: liked ? "heart.fill" : "heart", size: 64,
                            label: tr(liked ? "music.unfavourite" : "music.favourite")) {
                    favourite = !liked
                    Task { if (try? await MusicAPI.setFavourite(!liked, mediaId: t.mediaId, itemId: t.itemId)) == nil { favourite = liked } }
                }
            }
        }
        .frame(width: 520)
        .focusSection()
    }

    /// The lyrics when shown and available, else the queue.
    @ViewBuilder private var sidePane: some View {
        if showLyrics, let lyrics {
            LyricsView(lyrics: lyrics)
                .frame(maxWidth: .infinity, maxHeight: 560)
                .mask(LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.2),
                                             .init(color: .black, location: 0.8), .init(color: .clear, location: 1)],
                                     startPoint: .top, endPoint: .bottom))
        } else {
            QueueList().frame(maxWidth: .infinity, maxHeight: 560).focusSection()
        }
    }

    /// Left and right step the position; the bar is focusable on its own.
    private var seekBar: some View {
        VStack(spacing: 10) {
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(.white.opacity(0.2))
                    Capsule().fill(.white)
                        .frame(width: geo.size.width * (player.duration > 0 ? min(player.position / player.duration, 1) : 0))
                }
            }
            .frame(height: focus == .seek ? 16 : 8)
            HStack {
                Text(MusicFormat.duration(player.position))
                Spacer()
                Text("-" + MusicFormat.duration(max(player.duration - player.position, 0)))
            }
            .font(.callout.monospacedDigit()).foregroundStyle(.secondary)
        }
        .focusable()
        .focused($focus, equals: .seek)
        .onMoveCommand { direction in
            switch direction {
            case .left: player.perform(.seek(player.position - 10))
            case .right: player.perform(.seek(player.position + 10))
            default: break
            }
        }
        .animation(.easeOut(duration: 0.12), value: focus)
    }

    private func transport(_ t: QueueTrack) -> some View {
        let karaoke = karaokeReady && (lyrics?.cueLine?.isEmpty == false || hasCdg)
        return ZStack {
            HStack(spacing: 40) {
                RoundButton(symbol: "shuffle", size: 80, active: player.shuffled, label: tr("music_player.shuffle")) {
                    player.toggleShuffle()
                }
                RoundButton(symbol: "backward.fill", size: 80, label: tr("music_player.previous")) { player.perform(.previous) }
                RoundButton(symbol: player.isPlaying ? "pause.fill" : "play.fill", size: 112, filled: true,
                            label: tr(player.isPlaying ? "audio_player.pause" : "audio_player.play")) {
                    player.togglePlayPause()
                }
                .focused($focus, equals: .play)
                RoundButton(symbol: "forward.fill", size: 80, label: tr("music_player.next")) { player.perform(.next) }
                RoundButton(symbol: player.repeatMode == .one ? "repeat.1" : "repeat", size: 80,
                            active: player.repeatMode != .off, label: tr("music_player.repeat_\(player.repeatMode.rawValue)")) {
                    player.cycleRepeat()
                }
            }
            HStack(spacing: 20) {
                Spacer()
                if party.active {
                    RoundButton(symbol: "person.2.slash", size: 72, label: tr("party.leave")) { Task { await party.leaveToHome() } }
                }
                if karaoke {
                    RoundButton(symbol: "music.mic", size: 72, label: tr("karaoke.title")) { showKaraoke = true }
                }
                if lyrics != nil {
                    RoundButton(symbol: "quote.bubble", size: 72, active: showLyrics, label: tr("lyrics.title")) { showLyrics.toggle() }
                }
                RoundButton(symbol: "list.bullet", size: 72, active: !(showLyrics && lyrics != nil), label: tr("music_player.queue")) {
                    showLyrics = false
                }
                RoundMenu(symbol: "ellipsis", size: 72, label: tr("common.more")) {
                    Button { onSelectAlbum(t.mediaId) } label: { Label(tr("music.open_album"), systemImage: "square.stack") }
                    ForEach(artists(t), id: \.id) { a in
                        Button { onSelectArtist(a.id) } label: { Label(a.creditedName ?? a.name, systemImage: "music.mic") }
                    }
                    Menu {
                        ForEach(ReplayGain.allCases, id: \.self) { g in
                            // A toggle shows the menu's check; a second Text is the item's subtitle.
                            Toggle(isOn: Binding(get: { player.replayGain == g }, set: { if $0 { player.replayGain = g } })) {
                                Text(tr("music_player.replay_gain_mode_\(g.rawValue)"))
                                if g != .off { Text(tr("music_player.replay_gain_mode_\(g.rawValue)_hint")) }
                            }
                        }
                    } label: {
                        Label(tr("music_player.replay_gain"), systemImage: "speaker.wave.2")
                    }
                }
            }
        }
        .focusSection()
    }
}

/// The upcoming and past tracks: tap to jump, long press to remove.
private struct QueueList: View {
    @State private var player = MusicPlayer.shared

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 10) {
                    ForEach(Array(player.queue.tracks.enumerated()), id: \.element.id) { i, t in
                        TrackLine(number: String(i + 1), title: t.title, subtitle: t.artists,
                                  duration: MusicFormat.duration(t.durationSeconds), playing: i == player.queue.index,
                                  onRemove: { player.remove(at: i) }) {
                            player.skip(to: i)
                        }
                        .id(t.id)
                    }
                }
                .padding(.vertical, 8)
            }
            .onAppear { if let id = player.current?.id { proxy.scrollTo(id, anchor: .top) } }
        }
    }
}
