import SwiftUI

/// Square cover card: label below and outside the focusable art, like the poster cards.
struct AlbumTile: View {
    let imagePath: String?
    let title: String
    var subtitle: String?
    var dimmed = false
    var onSelect: () -> Void

    @FocusState private var focused: Bool
    @Environment(Backdrop.self) private var backdrop

    private static let side: CGFloat = 236

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button(action: onSelect) {
                PosterImage(path: imagePath)
                    .frame(width: Self.side, height: Self.side)
                    .clipped()
            }
            .buttonStyle(.card)
            .focused($focused)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.callout).lineLimit(1).foregroundStyle(focused ? .primary : .secondary)
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            .offset(y: focused ? 16 : 0)
            .animation(.easeOut(duration: 0.15), value: focused)
        }
        .frame(width: Self.side, alignment: .leading)
        .opacity(dimmed ? 0.5 : 1)
        .onChange(of: focused) { _, now in
            guard now else { return }
            SoundManager.play()
            if let imagePath { backdrop.url = imagePath }
        }
    }
}

/// Round artist portrait: the native borderless lift, name below.
struct ArtistTile: View {
    let imagePath: String?
    let name: String
    var caption: String?
    var onSelect: () -> Void

    @FocusState private var focused: Bool

    private static let side: CGFloat = 220

    var body: some View {
        VStack(spacing: 14) {
            Button(action: onSelect) {
                Group {
                    if let imagePath {
                        PosterImage(path: imagePath, size: .medium)
                    } else {
                        ZStack {
                            Rectangle().fill(Color.white.opacity(0.12))
                            Image(systemName: "music.mic").font(.system(size: 64)).foregroundStyle(.white.opacity(0.4))
                        }
                    }
                }
                .frame(width: Self.side, height: Self.side)
                .clipShape(Circle())
            }
            .buttonStyle(.borderless)
            .focused($focused)
            VStack(spacing: 2) {
                Text(name).font(.callout).lineLimit(1).foregroundStyle(focused ? .primary : .secondary)
                if let caption { Text(caption).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
            }
            .frame(width: Self.side + 20)
            .offset(y: focused ? 12 : 0)
            .animation(.easeOut(duration: 0.15), value: focused)
        }
        .frame(width: Self.side + 20)
    }
}

/// What a track row offers on a long press.
struct TrackActions {
    var favourite: Bool
    var rating: Int?
    var onFavourite: () -> Void
    var onRate: (Int?) -> Void
    var onPlaylist: () -> Void
    var onPlayNext: () -> Void
    var onQueue: () -> Void
    /// Puts the track forward as a song to sing; set while a party is joined.
    var onSing: (() -> Void)? = nil
}

/// One line of a track list: number or cover, title, artists, duration; a white pill when focused.
struct TrackLine: View {
    var number: String?
    var imagePath: String?
    let title: String
    var subtitle: String?
    var duration: String
    var explicit = false
    var favourite = false
    var playing = false
    var disabled = false
    var actions: TrackActions?
    /// Adds a remove entry to the long-press menu (the queue).
    var onRemove: (() -> Void)?
    var onPlay: () -> Void

    var body: some View {
        let row = Button(action: onPlay) { Content(number: number, imagePath: imagePath, title: title, subtitle: subtitle,
                                                   duration: duration, explicit: explicit, favourite: favourite, playing: playing) }
            .buttonStyle(TrackLineStyle())
            .disabled(disabled)
            .opacity(disabled ? 0.45 : 1)
        if actions != nil || onRemove != nil {
            row.contextMenu {
                if let actions { menu(actions) }
                if let onRemove {
                    Button(role: .destructive, action: onRemove) { Label(tr("music_player.remove"), systemImage: "trash") }
                }
            }
        } else {
            row
        }
    }

    @ViewBuilder private func menu(_ a: TrackActions) -> some View {
        Button(action: a.onFavourite) {
            Label(tr(a.favourite ? "music.unfavourite" : "music.favourite"), systemImage: a.favourite ? "heart.slash" : "heart")
        }
        if let sing = a.onSing {
            Button(action: sing) { Label(tr("karaoke.sing"), systemImage: "music.mic") }
        }
        ForEach(1...5, id: \.self) { n in
            Button { a.onRate(a.rating == n ? nil : n) } label: {
                Label(trp("music_player.rate_n", ["n": String(n)]), systemImage: (a.rating ?? 0) >= n ? "star.fill" : "star")
            }
        }
        Button(action: a.onPlayNext) { Label(tr("music.play_next"), systemImage: "text.insert") }
        Button(action: a.onQueue) { Label(tr("music.add_to_queue"), systemImage: "text.append") }
        Button(action: a.onPlaylist) { Label(tr("playlists.add_to_playlist_title"), systemImage: "text.badge.plus") }
    }

    private struct Content: View {
        let number: String?
        let imagePath: String?
        let title: String
        let subtitle: String?
        let duration: String
        let explicit: Bool
        let favourite: Bool
        let playing: Bool
        @Environment(\.isFocused) private var focused

        var body: some View {
            HStack(spacing: 22) {
                leading
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 10) {
                        Text(title).font(.body.weight(.semibold)).lineLimit(1)
                        if explicit {
                            Text("E").font(.caption.weight(.bold)).padding(.horizontal, 7).padding(.vertical, 1)
                                .background(RoundedRectangle(cornerRadius: 4).fill(.secondary.opacity(0.35)))
                                .accessibilityLabel(tr("music.explicit"))
                        }
                    }
                    if let subtitle, !subtitle.isEmpty {
                        Text(subtitle).font(.callout).lineLimit(1).opacity(0.7)
                    }
                }
                Spacer(minLength: 20)
                if favourite { Image(systemName: "heart.fill").foregroundStyle(.pink) }
                Text(duration).font(.callout.monospacedDigit()).opacity(0.7)
            }
            .foregroundStyle(focused ? Color.black : Color.white)
            .padding(.vertical, 14)
            .padding(.horizontal, 24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }

        @ViewBuilder private var leading: some View {
            if let imagePath {
                PosterImage(path: imagePath, size: .thumb).frame(width: 72, height: 72).clipShape(RoundedRectangle(cornerRadius: 8))
            } else {
                ZStack {
                    if playing { Image(systemName: "speaker.wave.2.fill") } else { Text(number ?? "") }
                }
                .font(.callout.monospacedDigit()).opacity(0.7).frame(width: 52)
            }
        }
    }
}

private struct TrackLineStyle: ButtonStyle {
    @Environment(\.isFocused) private var focused

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(RoundedRectangle(cornerRadius: 12).fill(focused ? Color.white : Color.white.opacity(0.06)))
            .scaleEffect(focused ? 1.02 : 1)
            .opacity(configuration.isPressed ? 0.8 : 1)
            .animation(.easeOut(duration: 0.12), value: focused)
    }
}
