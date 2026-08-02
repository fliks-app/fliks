import SwiftUI

/// GET /api/media/:id: full-bleed fanart backdrop, logo/title, metadata row,
/// synopsis, cast Rail, primary Play/Resume and favorite toggle. Series add
/// a season picker + per-season episode Rail (stills, hasFile-gated).
struct MediaDetailView: View {
    let mediaId: Int
    /// P5 owns actual playback — this only hands off the resolved target.
    var onPlay: (_ mediaFileId: Int, _ episodeId: Int?, _ startAt: Double) -> Void
    var onSelectEpisode: (_ episodeId: Int) -> Void

    private enum LoadState {
        case loading
        case loaded(Media)
        case failed
    }

    @State private var state: LoadState = .loading
    @State private var cast: [MediaCastEntry] = []
    @State private var resumeInfo: MediaResumeInfo?
    @State private var liked = false
    @State private var activeSeasonId: Int?
    @Environment(Backdrop.self) private var backdrop
    @Environment(WatchedStore.self) private var watched
    @Environment(PlaylistPicker.self) private var playlistPicker

    private var isWatched: Bool { watched.isWatched(mediaId: mediaId) }

    var body: some View {
        Group {
            switch state {
            case .loading:
                ProgressView()
                    .controlSize(.large)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed:
                VStack(spacing: 20) {
                    Text(tr("media_detail.load_error")).font(.title3)
                    Button(tr("common.retry")) { Task { await load() } }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .loaded(let media):
                content(media)
            }
        }
        .task { await load() }
    }

    @ViewBuilder
    private func content(_ media: Media) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 40) {
                header(media)

                if media.type == "series", let seasons = media.seasons, !seasons.isEmpty {
                    seasonPicker(seasons)
                    if let season = seasons.first(where: { $0.id == activeSeasonId }) {
                        episodesRail(season: season)
                    }
                }

                if !cast.isEmpty {
                    Rail(title: tr("media_detail.cast"), items: cast) { entry in
                        MediaCard(imagePath: entry.person.avatarUrl, title: entry.person.name,
                                  subtitle: entry.character) {}
                    }
                }
            }
            .padding(.horizontal, 60)
            .padding(.vertical, 48)
        }
        .onAppear {
            backdrop.url = media.fanartUrl ?? media.posterUrl
            if activeSeasonId == nil {
                activeSeasonId = (media.seasons ?? []).sorted { $0.seasonNumber < $1.seasonNumber }.first?.id
            }
        }
    }

    @ViewBuilder
    private func header(_ media: Media) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            if let logo = media.logoUrl {
                CachedAsyncImage(url: ImageURL.build(logo, size: .medium), contentMode: .fit) { Color.clear }
                    .frame(maxWidth: 520, maxHeight: 140, alignment: .leading)
            } else {
                Text(media.title).font(.system(size: 48, weight: .bold))
            }

            HStack(spacing: 16) {
                if let year = media.year { Text(String(year)) }
                if let rating = media.rating, rating > 0 { Text(String(format: "%.1f ★", rating)) }
                if let runtime = media.runtime, runtime > 0 {
                    Text(tr("media_detail.runtime_minutes", runtime))
                }
                if let genres = media.genres, !genres.isEmpty {
                    Text(genres.joined(separator: ", "))
                }
            }
            .font(.callout)
            .foregroundStyle(.secondary)

            if let overview = media.overview, !overview.isEmpty {
                Text(overview)
                    .font(.body)
                    .lineLimit(4)
                    .frame(maxWidth: 900, alignment: .leading)
            }

            HStack(spacing: 24) {
                if let target = playTarget(media) {
                    Button(action: { onPlay(target.mediaFileId, target.episodeId, target.startAt) }) {
                        Label(target.resume ? tr("common.resume") : tr("common.play"), systemImage: "play.fill")
                    }
                    .buttonStyle(.borderedProminent)
                }
                Button(action: { Task { await toggleFavorite() } }) {
                    Label {
                        Text(liked ? tr("media_detail.unfavorite") : tr("media_detail.favorite"))
                    } icon: {
                        Image(systemName: liked ? "heart.fill" : "heart")
                            .foregroundStyle(liked ? Color.red : Color.primary)
                    }
                }
                .buttonStyle(.bordered)

                Button(action: { Task { await toggleWatched(media) } }) {
                    Label(watchedLabel(media), systemImage: isWatched ? "eye.slash" : "checkmark.circle")
                }
                .buttonStyle(.bordered)

                Button(action: { playlistPicker.open(mediaId: mediaId) }) {
                    Label(tr("playlists.add_to_playlist_title"), systemImage: "text.badge.plus")
                }
                .buttonStyle(.bordered)
            }
        }
        .focusSection()
    }

    private struct PlayTarget {
        let mediaFileId: Int
        let episodeId: Int?
        let startAt: Double
        let resume: Bool
    }

    /// Movie: the file with no episodeId. Series: the resume target if any,
    /// else the first episode with a file, season order. ponytail: skips the
    /// "first unwatched episode" tier (needs per-episode watched state, not
    /// loaded here) — add it if the plain header target reads wrong once
    /// watched-tracking lands on this screen.
    private func playTarget(_ media: Media) -> PlayTarget? {
        if media.type != "series" {
            guard let fileId = resumeInfo?.mediaFileId ?? media.files?.first(where: { $0.episodeId == nil })?.id else {
                return nil
            }
            let position = resumeInfo?.positionSeconds ?? 0
            return PlayTarget(mediaFileId: fileId, episodeId: nil, startAt: position, resume: position > 0)
        }
        if let info = resumeInfo, let episodeId = info.episodeId {
            return PlayTarget(mediaFileId: info.mediaFileId, episodeId: episodeId,
                               startAt: info.positionSeconds, resume: info.positionSeconds > 0)
        }
        for season in (media.seasons ?? []).sorted(by: { $0.seasonNumber < $1.seasonNumber }) {
            for ep in season.episodes.sorted(by: { $0.episodeNumber < $1.episodeNumber }) where ep.hasFile {
                if let file = media.files?.first(where: { $0.episodeId == ep.id }) {
                    return PlayTarget(mediaFileId: file.id, episodeId: ep.id, startAt: 0, resume: false)
                }
            }
        }
        return nil
    }

    @ViewBuilder
    private func seasonPicker(_ seasons: [Season]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 14) {
                ForEach(seasons.sorted(by: { $0.seasonNumber < $1.seasonNumber })) { season in
                    seasonButton(season)
                }
            }
            .padding(.vertical, 6)
        }
        .scrollClipDisabled()
        .focusSection()
    }

    private func seasonButton(_ season: Season) -> some View {
        SeasonButton(label: Self.seasonLabel(season), active: activeSeasonId == season.id) {
            activeSeasonId = season.id
        }
    }

    static func seasonLabel(_ season: Season) -> String {
        season.seasonNumber > 0
            ? tr("media_detail.season_number", season.seasonNumber)
            : tr("media_detail.specials")
    }

    @ViewBuilder
    private func episodesRail(season: Season) -> some View {
        Rail(title: tr("media_detail.episodes"),
             items: season.episodes.sorted { $0.episodeNumber < $1.episodeNumber }) { ep in
            MediaCard(imagePath: ep.stillUrl, title: "E\(ep.episodeNumber)", subtitle: ep.title,
                      portrait: false, mediaId: mediaId, episodeId: ep.id) {
                onSelectEpisode(ep.id)
            }
            .opacity(ep.hasFile ? 1 : 0.4)
        }
    }

    private func load() async {
        state = .loading
        cast = []
        resumeInfo = nil
        liked = false
        do {
            let media: Media = try await APIClient.shared.get("/api/media/\(mediaId)")
            state = .loaded(media)
        } catch {
            state = .failed
            return
        }
        await watched.loadSeries(mediaId)
        async let castTask: [MediaCastEntry] = APIClient.shared.get("/api/media/\(mediaId)/cast")
        async let resumeTask: MediaResumeInfo? = APIClient.shared.get("/api/playback/media/\(mediaId)")
        async let likeTask: LikeState = APIClient.shared.get("/api/likes/state/\(mediaId)")
        if let c = try? await castTask { cast = c }
        if let r = try? await resumeTask { resumeInfo = r }
        if let l = try? await likeTask { liked = l.media }
    }

    /// Selection has to survive losing focus, so the season keeps its own fill
    /// instead of relying on the system focus decoration.
    private struct SeasonButton: View {
        let label: String
        let active: Bool
        var action: () -> Void
        @FocusState private var focused: Bool

        var body: some View {
            Button(action: action) {
                Text(label)
                    .font(.callout.weight(active ? .semibold : .regular))
                    .foregroundStyle(active ? Color.black : Color.white)
                    .padding(.vertical, 12)
                    .padding(.horizontal, 26)
            }
            .buttonStyle(FlatButtonStyle())
            .background(RoundedRectangle(cornerRadius: 14)
                .fill(active ? Color.white : Color.white.opacity(0.16)))
            .overlay(RoundedRectangle(cornerRadius: 14)
                .strokeBorder(.white, lineWidth: focused ? 4 : 0))
            .scaleEffect(focused ? 1.06 : 1)
            .focused($focused)
            .animation(.easeOut(duration: 0.15), value: focused)
        }
    }

    private func watchedLabel(_ media: Media) -> String {
        if media.type == "series" {
            return isWatched ? tr("media_detail.mark_series_unwatched") : tr("media_detail.mark_series_watched")
        }
        return isWatched ? tr("media_card.mark_unwatched") : tr("media_card.mark_watched")
    }

    private func toggleWatched(_ media: Media) async {
        guard media.type == "series" else {
            await watched.toggle(mediaId: mediaId)
            return
        }
        // Mirrors the backend's own scope: episodes with a file, specials excluded.
        let episodeIds = (media.seasons ?? [])
            .filter { $0.seasonNumber > 0 }
            .flatMap(\.episodes)
            .filter(\.hasFile)
            .map(\.id)
        await watched.toggleSeries(mediaId: mediaId, watched: !isWatched, episodeIds: episodeIds)
    }

    private func toggleFavorite() async {
        struct Target: Encodable { let mediaId: Int }
        let target = Target(mediaId: mediaId)
        let was = liked
        liked = !was
        do {
            if was { try await APIClient.shared.delete("/api/likes", body: target) }
            else { try await APIClient.shared.post("/api/likes", body: target) }
        } catch {
            liked = was
        }
    }
}
