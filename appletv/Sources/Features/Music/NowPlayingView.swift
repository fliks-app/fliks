import SwiftUI

/// Full-screen Now Playing: cover, transport, seek, queue and volume levelling.
struct NowPlayingView: View {
    var onClose: () -> Void

    @State private var player = MusicPlayer.shared
    @State private var party = PartyService.shared
    @State private var showQueue = false
    @State private var favourite: Bool?
    @State private var rating: Int?
    @State private var lyrics: StructuredLyrics?
    @State private var showLyrics = false
    @State private var showKaraoke = false
    @State private var karaokeReady = false
    @State private var hasCdg = false
    @FocusState private var focus: Control?
    @Environment(Backdrop.self) private var backdrop

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
        .sheet(isPresented: $showQueue) { QueueSheet() }
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
        let cover: CGFloat = showLyrics ? 420 : 640
        return HStack(spacing: 70) {
            PosterImage(path: t.coverUrl, size: .full)
                .frame(width: cover, height: cover)
                .clipShape(RoundedRectangle(cornerRadius: 16))
                .shadow(radius: 30)
            if showLyrics, let lyrics {
                VStack(alignment: .leading, spacing: 18) {
                    LyricsView(lyrics: lyrics)
                    HStack(spacing: 36) {
                        transport
                        Button { showLyrics = false } label: { Image(systemName: "xmark") }
                            .accessibilityLabel(tr("lyrics.close_full"))
                            .buttonStyle(.bordered)
                    }
                }
            } else {
            VStack(alignment: .leading, spacing: 22) {
                Spacer(minLength: 0)
                Text(t.title).font(.system(size: 54, weight: .bold)).lineLimit(2)
                Text(t.artists).font(.title3).foregroundStyle(.secondary).lineLimit(1)
                Text(t.albumTitle).font(.callout).foregroundStyle(.secondary).lineLimit(1)
                seekBar.padding(.top, 14)
                transport
                options(t)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, 80)
        .padding(.vertical, 50)
        .onAppear { backdrop.url = t.coverUrl }
        .onChange(of: t.uid) { _, _ in favourite = nil; rating = nil; backdrop.url = t.coverUrl }
        .task(id: t.itemId) {
            lyrics = nil
            lyrics = await LyricsAPI.main(itemId: t.itemId)
            if lyrics == nil { showLyrics = false }
        }
    }

    /// Left and right step the position; the bar is focusable on its own.
    private var seekBar: some View {
        VStack(spacing: 8) {
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(.white.opacity(0.25))
                    Capsule().fill(.white)
                        .frame(width: geo.size.width * (player.duration > 0 ? min(player.position / player.duration, 1) : 0))
                }
            }
            .frame(height: focus == .seek ? 16 : 10)
            HStack {
                Text(MusicFormat.duration(player.position))
                Spacer()
                Text(MusicFormat.duration(player.duration))
            }
            .font(.callout.monospacedDigit()).foregroundStyle(.secondary)
        }
        .padding(18)
        .background(RoundedRectangle(cornerRadius: 14).fill(.white.opacity(focus == .seek ? 0.12 : 0)))
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

    private var transport: some View {
        HStack(spacing: 36) {
            Button { player.toggleShuffle() } label: {
                Image(systemName: "shuffle").foregroundStyle(player.shuffled ? Color.accentColor : .primary)
            }
            .accessibilityLabel(tr("music_player.shuffle"))
            Button { player.perform(.previous) } label: { Image(systemName: "backward.fill") }
                .accessibilityLabel(tr("music_player.previous"))
            Button { player.togglePlayPause() } label: {
                Image(systemName: player.isPlaying ? "pause.fill" : "play.fill").frame(width: 60)
            }
            .focused($focus, equals: .play)
            .accessibilityLabel(tr(player.isPlaying ? "audio_player.pause" : "audio_player.play"))
            Button { player.perform(.next) } label: { Image(systemName: "forward.fill") }
                .accessibilityLabel(tr("music_player.next"))
            Button { player.cycleRepeat() } label: {
                Image(systemName: player.repeatMode == .one ? "repeat.1" : "repeat")
                    .foregroundStyle(player.repeatMode == .off ? Color.primary : Color.accentColor)
            }
            .accessibilityLabel(tr("music_player.repeat_\(player.repeatMode.rawValue)"))
        }
        .font(.title2)
        .focusSection()
    }

    private func options(_ t: QueueTrack) -> some View {
        let liked = favourite ?? false
        return HStack(spacing: 28) {
            Button {
                favourite = !liked
                Task { if (try? await MusicAPI.setFavourite(!liked, mediaId: t.mediaId, itemId: t.itemId)) == nil { favourite = liked } }
            } label: { Image(systemName: liked ? "heart.fill" : "heart") }
                .accessibilityLabel(tr(liked ? "music.unfavourite" : "music.favourite"))
            if lyrics != nil {
                Button { showLyrics.toggle() } label: { Image(systemName: "quote.bubble") }
                    .accessibilityLabel(tr("lyrics.title"))
            }
            if karaokeReady, lyrics?.cueLine?.isEmpty == false || hasCdg {
                Button { showKaraoke = true } label: { Image(systemName: "music.mic") }
                    .accessibilityLabel(tr("karaoke.title"))
            }
            Button { showQueue = true } label: { Image(systemName: "list.bullet") }
                .accessibilityLabel(tr("music_player.queue"))
            Button { player.replayGain = player.replayGain.next } label: {
                Image(systemName: player.replayGain.symbol)
            }
            .accessibilityLabel(tr(player.replayGain.labelKey))
            if party.active {
                Button { Task { await party.leaveToHome() } } label: { Image(systemName: "person.2.slash") }
                    .accessibilityLabel(tr("party.leave"))
            }
        }
        .font(.title3)
        .buttonStyle(.bordered)
        .focusSection()
    }
}

/// The queue: tap to jump, long press to remove.
private struct QueueSheet: View {
    @State private var player = MusicPlayer.shared
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 24) {
            Text(tr("music_player.queue")).font(.title.bold())
            ScrollView {
                LazyVStack(spacing: 10) {
                    ForEach(Array(player.queue.tracks.enumerated()), id: \.element.id) { i, t in
                        TrackLine(number: String(i + 1), title: t.title, subtitle: t.artists,
                                  duration: MusicFormat.duration(t.durationSeconds), playing: i == player.queue.index,
                                  onRemove: { player.remove(at: i) }) {
                            player.skip(to: i)
                            dismiss()
                        }
                    }
                }
                .padding(.horizontal, 24).padding(.vertical, 20)
            }
            Button(tr("common.cancel")) { dismiss() }
        }
        .padding(60)
        .frame(maxWidth: 1100)
        .focusSection()
    }
}
