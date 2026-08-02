import SwiftUI

/// Remote artwork with a neutral placeholder. Takes a raw (unresolved) API
/// image path — resolving through `ImageURL.build` is this view's job, so
/// every caller gets the right `?size=` hint for free.
struct PosterImage: View {
    let path: String?
    var size: ImageSize = .medium

    var body: some View {
        CachedAsyncImage(url: ImageURL.build(path, size: size)) {
            ZStack {
                Rectangle().fill(Color.white.opacity(0.12))
                Image(systemName: "photo").font(.largeTitle).foregroundStyle(.white.opacity(0.35))
            }
        }
    }
}

/// The one card used across every Home rail: poster/still + title + optional
/// subtitle and resume-progress bar. Focus brightens the title and pushes
/// `backdropPath` (falling back to the poster) into the ambient `Backdrop`.
struct MediaCard: View {
    let imagePath: String?
    let title: String?
    var subtitle: String? = nil
    var portrait: Bool = true
    /// 0-100 resume progress; nil falls back to `WatchedStore`, 0 hides the bar.
    var progressPercent: Double? = nil
    var backdropPath: String? = nil
    /// Set to show the watched badge and offer the card actions.
    var mediaId: Int? = nil
    var episodeId: Int? = nil
    var onSelect: () -> Void

    @FocusState private var focused: Bool
    @Environment(Backdrop.self) private var backdrop
    @Environment(WatchedStore.self) private var watched

    private var size: CGSize { portrait ? CGSize(width: 220, height: 330) : CGSize(width: 360, height: 202) }

    private var isWatched: Bool {
        guard let mediaId else { return false }
        return watched.isWatched(mediaId: mediaId, episodeId: episodeId)
    }

    private var progress: Double? {
        if let progressPercent { return progressPercent }
        guard let mediaId else { return nil }
        return watched.progress(mediaId: mediaId, episodeId: episodeId)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button(action: onSelect) {
                ZStack(alignment: .bottom) {
                    PosterImage(path: imagePath)
                        .frame(width: size.width, height: size.height)
                        .clipped()
                    if let progress, progress > 0 {
                        ProgressBar(percent: progress).padding(8)
                    }
                }
                .overlay(alignment: .topTrailing) { if isWatched { WatchedBadge() } }
            }
            .buttonStyle(.card)
            .cardActions(mediaId: mediaId, episodeId: episodeId)
            .focused($focused)

            if let title, !title.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.callout)
                        .lineLimit(1)
                        .foregroundStyle(focused ? .primary : .secondary)
                    if let subtitle, !subtitle.isEmpty {
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                .offset(y: focused ? 12 : 0)
                .animation(.easeOut(duration: 0.15), value: focused)
            }
        }
        .frame(width: size.width, alignment: .leading)
        .onChange(of: focused) { _, now in
            guard now else { return }
            SoundManager.play()
            // A card with no artwork (a playlist with no posters, a request
            // without a poster) keeps the current backdrop rather than
            // flashing the bare black root.
            if let path = backdropPath ?? imagePath { backdrop.url = path }
        }
    }
}

/// Resume bar drawn over card artwork — its own track, since the system
/// `ProgressView` washes out over a bright still.
struct ProgressBar: View {
    /// 0-100.
    let percent: Double

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(.black.opacity(0.55))
                Capsule().fill(.white)
                    .frame(width: geo.size.width * min(max(percent, 0), 100) / 100)
            }
        }
        .frame(height: 6)
    }
}

/// Watched marker drawn over card artwork.
struct WatchedBadge: View {
    var body: some View {
        Image(systemName: "checkmark.circle.fill")
            .font(.system(size: 34))
            .symbolRenderingMode(.palette)
            .foregroundStyle(.white, .green)
            .padding(8)
    }
}

/// Long-press actions shared by every card: watched toggle + add to playlist.
private struct CardActions: ViewModifier {
    let mediaId: Int?
    let episodeId: Int?
    @Environment(WatchedStore.self) private var watched
    @Environment(PlaylistPicker.self) private var picker

    @ViewBuilder
    func body(content: Content) -> some View {
        if let mediaId {
            content.contextMenu {
                Button {
                    Task { await watched.toggle(mediaId: mediaId, episodeId: episodeId) }
                } label: {
                    let isWatched = watched.isWatched(mediaId: mediaId, episodeId: episodeId)
                    Label(isWatched ? tr("media_card.mark_unwatched") : tr("media_card.mark_watched"),
                          systemImage: isWatched ? "eye.slash" : "checkmark.circle")
                }
                Button {
                    picker.open(mediaId: mediaId, episodeId: episodeId)
                } label: {
                    Label(tr("playlists.add_to_playlist_title"), systemImage: "text.badge.plus")
                }
            }
        } else {
            content
        }
    }
}

extension View {
    func cardActions(mediaId: Int?, episodeId: Int? = nil) -> some View {
        modifier(CardActions(mediaId: mediaId, episodeId: episodeId))
    }
}

/// Bare-bones poster card (no subtitle/backdrop push) for simpler listings —
/// search results, playlist items.
struct PosterCard: View {
    let imagePath: String?
    let title: String?
    var portrait: Bool = true
    var progressPercent: Double? = nil
    var mediaId: Int? = nil
    var episodeId: Int? = nil
    var onSelect: () -> Void
    @FocusState private var focused: Bool
    @Environment(WatchedStore.self) private var watched

    private var size: CGSize { portrait ? CGSize(width: 220, height: 330) : CGSize(width: 360, height: 202) }

    private var isWatched: Bool {
        guard let mediaId else { return false }
        return watched.isWatched(mediaId: mediaId, episodeId: episodeId)
    }

    private var progress: Double? {
        if let progressPercent { return progressPercent }
        guard let mediaId else { return nil }
        return watched.progress(mediaId: mediaId, episodeId: episodeId)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button(action: onSelect) {
                ZStack(alignment: .bottom) {
                    PosterImage(path: imagePath)
                        .frame(width: size.width, height: size.height)
                        .clipped()
                    if let progress, progress > 0 {
                        ProgressBar(percent: progress).padding(8)
                    }
                }
                .overlay(alignment: .topTrailing) { if isWatched { WatchedBadge() } }
            }
            .buttonStyle(.card)
            .cardActions(mediaId: mediaId, episodeId: episodeId)
            .focused($focused)
            if let title, !title.isEmpty {
                Text(title).font(.callout).lineLimit(1)
                    .foregroundStyle(focused ? .primary : .secondary)
                    .offset(y: focused ? 12 : 0)
                    .animation(.easeOut(duration: 0.15), value: focused)
            }
        }
        .frame(width: size.width, alignment: .leading)
    }
}

/// Horizontal rail of cards. Generic over the item type and its card
/// presentation so every zone can reuse this one scroller.
struct Rail<Item: Identifiable, Card: View>: View {
    let title: String?
    let items: [Item]
    let card: (Item) -> Card

    init(title: String?, items: [Item], @ViewBuilder card: @escaping (Item) -> Card) {
        self.title = title
        self.items = items
        self.card = card
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if let title, !title.isEmpty {
                Text(title).font(.title2.bold())
            }
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 30) {
                    ForEach(items) { item in card(item) }
                }
                .padding(.vertical, 16)
            }
            .scrollClipDisabled()
        }
        .focusSection()
    }
}

/// Fixed-column grid of cards (library browsing, search — P4+). Same
/// generic shape as `Rail`.
struct ContentGrid<Item: Identifiable, Card: View>: View {
    let title: String?
    let items: [Item]
    var columns: Int = 6
    var onReachEnd: (() -> Void)?
    let card: (Item) -> Card

    init(title: String?, items: [Item], columns: Int = 6, onReachEnd: (() -> Void)? = nil,
         @ViewBuilder card: @escaping (Item) -> Card) {
        self.title = title
        self.items = items
        self.columns = columns
        self.onReachEnd = onReachEnd
        self.card = card
    }

    private var gridColumns: [GridItem] {
        Array(repeating: GridItem(.flexible(), spacing: 30), count: columns)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if let title, !title.isEmpty { Text(title).font(.title2.bold()) }
            LazyVGrid(columns: gridColumns, spacing: 30) {
                ForEach(Array(items.enumerated()), id: \.element.id) { idx, item in
                    card(item)
                        .onAppear { if idx >= items.count - columns { onReachEnd?() } }
                }
            }
        }
        .focusSection()
    }
}

// MARK: - Skeletons

struct SkeletonBox: View {
    var cornerRadius: CGFloat = 12
    var body: some View {
        RoundedRectangle(cornerRadius: cornerRadius).fill(Color.white.opacity(0.06))
    }
}

struct SkeletonRail: View {
    let title: String?
    var portrait: Bool = true
    private var size: CGSize { portrait ? .init(width: 220, height: 330) : .init(width: 360, height: 202) }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if let title, !title.isEmpty { Text(title).font(.title2.bold()) }
            HStack(spacing: 30) {
                ForEach(0..<5, id: \.self) { _ in
                    SkeletonBox().frame(width: size.width, height: size.height)
                }
            }
        }
    }
}

struct SkeletonHero: View {
    var body: some View {
        SkeletonBox(cornerRadius: 18).frame(height: 480).frame(maxWidth: .infinity)
    }
}

// MARK: - Hero (unused by Home's all-rail layout; ready for a future banner zone)

/// One full-bleed hero slide (poster + gradient + title). The whole slide is
/// the focusable button so the carousel can page with left/right moves.
struct HeroSlide: View {
    let imagePath: String?
    let title: String
    var onSelect: () -> Void

    var body: some View {
        Button(action: onSelect) {
            ZStack(alignment: .bottomLeading) {
                PosterImage(path: imagePath, size: .full)
                    .frame(height: 480)
                    .frame(maxWidth: .infinity)
                    .clipped()
                LinearGradient(colors: [.clear, .black.opacity(0.85)],
                               startPoint: .center, endPoint: .bottom)
                Text(title)
                    .font(.system(size: 48, weight: .bold))
                    .padding(44)
            }
            .frame(height: 480)
        }
        .buttonStyle(HeroSlideStyle())
    }
}

/// No system focus decoration — for controls that draw their own.
struct FlatButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.7 : 1)
    }
}

/// Custom style so the full-width hero gets no system focus float/border.
private struct HeroSlideStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .clipShape(RoundedRectangle(cornerRadius: 18))
            .opacity(configuration.isPressed ? 0.92 : 1)
    }
}

/// Multi-item hero carousel (paged `TabView`). Selection drives the ambient backdrop.
struct HeroCarousel<Item: Identifiable>: View {
    let items: [Item]
    let imagePath: (Item) -> String?
    let title: (Item) -> String
    var onSelect: (Item) -> Void

    @State private var selection = 0
    @Environment(Backdrop.self) private var backdrop

    var body: some View {
        TabView(selection: $selection) {
            ForEach(Array(items.enumerated()), id: \.element.id) { idx, item in
                HeroSlide(imagePath: imagePath(item), title: title(item)) { onSelect(item) }
                    .padding(.horizontal, 12)
                    .tag(idx)
            }
        }
        .tabViewStyle(.page(indexDisplayMode: items.count > 1 ? .always : .never))
        .frame(height: 500)
        .onChange(of: selection) { _, i in updateBackdrop(i) }
        .task { updateBackdrop(0) }
    }

    private func updateBackdrop(_ i: Int) {
        guard items.indices.contains(i) else { return }
        backdrop.url = imagePath(items[i])
    }
}
