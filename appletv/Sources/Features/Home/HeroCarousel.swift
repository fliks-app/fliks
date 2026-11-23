import SwiftUI

/// A few featured titles, one at a time, over their own fanart: the tvOS side of the client's
/// `app-hero-carousel`. Auto-advances unless focus is inside, the app is inactive or motion is reduced.
struct HeroCarousel: View {
    let items: [Media]
    /// Library pages: a shorter frame under the library name.
    var label: String?
    var onPlay: (_ mediaFileId: Int, _ mediaId: Int, _ episodeId: Int?) -> Void
    var onDetails: (Media) -> Void

    private enum Focus: Hashable { case primary, details, add, dot(Int) }

    @State private var index = 0
    @State private var targets: [Int: PlayTarget?] = [:]
    @FocusState private var focus: Focus?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(PlaylistPicker.self) private var playlistPicker
    @Environment(WatchedStore.self) private var watched

    private var compact: Bool { label != nil }
    private var height: CGFloat { compact ? 560 : 740 }
    private var current: Media? { items.isEmpty ? nil : items[index % items.count] }
    private var running: Bool { !reduceMotion && focus == nil && scenePhase == .active && items.count > 1 }

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            picture
            if let m = current {
                VStack(alignment: .leading, spacing: 22) {
                    if let label { Text(label).font(.title3.weight(.semibold)).foregroundStyle(.secondary) }
                    slide(m)
                        .id(m.id)
                        .transition(reduceMotion ? .opacity : .asymmetric(
                            insertion: .opacity.combined(with: .offset(x: 40)), removal: .opacity))
                    if items.count > 1 { dots }
                }
                .padding(.leading, 120)
                .padding(.bottom, 40)
            }
        }
        .frame(maxWidth: .infinity, minHeight: height, maxHeight: height, alignment: .bottomLeading)
        .focusSection()
        .task(id: "\(index)-\(running)") {
            guard running else { return }
            try? await Task.sleep(for: .seconds(7))
            guard !Task.isCancelled else { return }
            go(index + 1)
        }
        .task(id: current?.id) { await resolveTarget() }
    }

    /// Fades out to transparent, not to a colour: the page's ambient backdrop shows through, with no seam.
    private var picture: some View {
        CrossfadeImage(url: ImageURL.build(current?.fanartUrl, size: .full))
            .overlay(LinearGradient(colors: [.black.opacity(0.7), .black.opacity(0.2), .clear],
                                    startPoint: .leading, endPoint: .trailing))
            .mask(LinearGradient(colors: [.black, .black, .clear], startPoint: .top, endPoint: .bottom))
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .clipped()
            .ignoresSafeArea()
            .accessibilityHidden(true)
    }

    private func slide(_ m: Media) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            if let logo = m.logoUrl {
                CachedAsyncImage(url: ImageURL.build(logo, size: .medium), contentMode: .fit) {
                    Text(m.title).font(.system(size: 64, weight: .bold))
                }
                .frame(maxWidth: 560, maxHeight: compact ? 120 : 160, alignment: .leading)
            } else {
                Text(m.title).font(.system(size: compact ? 52 : 64, weight: .bold)).lineLimit(2)
            }
            HStack(spacing: 16) {
                ForEach(facts(m), id: \.self) { Text($0) }
            }
            .font(.callout)
            .foregroundStyle(.secondary)
            if let overview = m.overview, !overview.isEmpty {
                Text(overview).font(.body).lineLimit(compact ? 2 : 3).frame(maxWidth: 900, alignment: .leading)
            }
            actions(m)
        }
        .shadow(color: .black.opacity(0.4), radius: 8)
    }

    private func facts(_ m: Media) -> [String] {
        var parts: [String] = []
        if let year = m.year { parts.append(String(year)) }
        if let rating = m.rating, rating > 0 { parts.append(String(format: "%.1f ★", rating)) }
        if let runtime = m.runtime, runtime > 0 { parts.append(tr("media_detail.runtime_minutes", runtime)) }
        if let genres = m.genres, !genres.isEmpty { parts.append(genres.prefix(2).joined(separator: ", ")) }
        return parts
    }

    /// A series swaps Details for Play once its episode is known; focus stays on the same button.
    private func actions(_ m: Media) -> some View {
        let target = targets[m.id] ?? nil
        let play = target != nil || !m.type.hasChildren
        return HStack(spacing: 24) {
            Button {
                if let target { onPlay(target.mediaFileId, m.id, target.episodeId) } else { onDetails(m) }
            } label: {
                if play {
                    Label(playLabel(target), systemImage: "play.fill")
                } else {
                    Label(tr("hero_carousel.details"), systemImage: "info.circle")
                }
            }
            .buttonStyle(.borderedProminent)
            .focused($focus, equals: .primary)
            if play {
                Button(tr("hero_carousel.details")) { onDetails(m) }
                    .buttonStyle(.bordered)
                    .focused($focus, equals: .details)
            }
            Button { playlistPicker.open(mediaId: m.id) } label: { Image(systemName: "text.badge.plus") }
                .buttonStyle(.bordered)
                .focused($focus, equals: .add)
                .accessibilityLabel(tr("playlists.add_to_playlist"))
        }
        .defaultFocus($focus, .primary)
    }

    private func playLabel(_ target: PlayTarget?) -> String {
        guard let code = target?.code else { return tr("hero_carousel.play") }
        return trp(target?.resume == true ? "hero_carousel.resume_episode" : "hero_carousel.play_episode", ["code": code])
    }

    /// Entering the dots lands on the slide shown; focusing a dot shows its slide. The current dot is three
    /// wide as on the web; the gap leaves the focus ring clear of the next dot.
    private var dots: some View {
        HStack(spacing: 18) {
            ForEach(items.indices, id: \.self) { i in
                Button { go(i) } label: {
                    Capsule()
                        .fill(.white.opacity(i == index ? 1 : 0.4))
                        .frame(width: i == index ? 42 : 14, height: 14)
                        .padding(.vertical, 10)
                }
                .buttonStyle(DotStyle(focused: focus == .dot(i)))
                .focused($focus, equals: .dot(i))
                .accessibilityLabel(trp("hero_carousel.go_to", ["n": String(i + 1)]))
            }
        }
        .focusSection()
        .defaultFocus($focus, .dot(index), priority: .userInitiated)
        .onChange(of: focus) { _, f in if case let .dot(i) = f { go(i) } }
    }

    private func go(_ i: Int) {
        guard !items.isEmpty else { return }
        let next = ((i % items.count) + items.count) % items.count
        guard next != index else { return }
        withAnimation(.easeInOut(duration: 0.45)) { index = next }
    }

    /// Movies need their file id, series their next episode: both come with the full title.
    private func resolveTarget() async {
        guard let m = current, targets[m.id] == nil else { return }
        guard let media: Media = try? await APIClient.shared.get("/api/media/\(m.id)") else { return }
        let resume: MediaResumeInfo?? = try? await APIClient.shared.get("/api/playback/media/\(m.id)")
        if m.type.hasChildren { await watched.loadSeries(m.id) }
        let target = PlayTarget.of(media, resume: resume ?? nil, watchedEpisodes: watched.watchedEpisodes[m.id] ?? [])
        targets[m.id] = .some(target)
    }
}

private struct DotStyle: ButtonStyle {
    let focused: Bool
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            // Drawn past the dot's own width, so the ring needs no space between the dots.
            .overlay(Capsule().strokeBorder(.white, lineWidth: focused ? 3 : 0).padding(.horizontal, -5).padding(.vertical, 5))
            .animation(.easeOut(duration: 0.15), value: focused)
    }
}
