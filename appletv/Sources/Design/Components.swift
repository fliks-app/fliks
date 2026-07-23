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
    /// 0-100 resume progress; nil or 0 hides the bar.
    var progressPercent: Double? = nil
    var backdropPath: String? = nil
    var onSelect: () -> Void

    @FocusState private var focused: Bool
    @Environment(Backdrop.self) private var backdrop

    private var size: CGSize { portrait ? CGSize(width: 220, height: 330) : CGSize(width: 360, height: 202) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button(action: onSelect) {
                ZStack(alignment: .bottom) {
                    PosterImage(path: imagePath)
                        .frame(width: size.width, height: size.height)
                        .clipped()
                    if let progressPercent, progressPercent > 0 {
                        ProgressView(value: min(progressPercent, 100), total: 100)
                            .tint(.white)
                            .padding(6)
                    }
                }
            }
            .buttonStyle(.card)
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
            backdrop.url = backdropPath ?? imagePath
        }
    }
}

/// Bare-bones poster card (no subtitle/progress/backdrop push) for simpler
/// listings — search results, etc.
struct PosterCard: View {
    let imagePath: String?
    let title: String?
    var portrait: Bool = true
    var onSelect: () -> Void
    @FocusState private var focused: Bool

    private var size: CGSize { portrait ? CGSize(width: 220, height: 330) : CGSize(width: 360, height: 202) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button(action: onSelect) {
                PosterImage(path: imagePath)
                    .frame(width: size.width, height: size.height)
                    .clipped()
            }
            .buttonStyle(.card)
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
