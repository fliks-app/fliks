import SwiftUI

/// GET /api/media/:id: full-bleed fanart backdrop, logo/title, metadata row,
/// synopsis, cast Rail, primary Play/Resume and favorite toggle. Series add
/// a season picker + per-season episode Rail (stills, hasFile-gated).
struct MediaDetailView: View {
    let mediaId: Int
    /// P5 owns actual playback — this only hands off the resolved target.
    var onPlay: (_ mediaFileId: Int, _ episodeId: Int?, _ startAt: Double) -> Void

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

                if !cast.isEmpty {
                    Rail(title: tr("media_detail.cast"), items: cast) { entry in
                        MediaCard(imagePath: entry.person.avatarUrl, title: entry.person.name,
                                  subtitle: entry.character) {}
                    }
                }

                if media.type == "series", let seasons = media.seasons, !seasons.isEmpty {
                    seasonPicker(seasons)
                    if let season = seasons.first(where: { $0.id == activeSeasonId }) {
                        episodesRail(media: media, season: season)
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
                    Label(liked ? tr("media_detail.unfavorite") : tr("media_detail.favorite"),
                          systemImage: liked ? "heart.fill" : "heart")
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

    /// Split into if/else (not a `.buttonStyle(cond ? .a : .b)` ternary) —
    /// `.borderedProminent`/`.bordered` are different concrete style types.
    @ViewBuilder
    private func seasonButton(_ season: Season) -> some View {
        let label = season.seasonNumber > 0
            ? tr("media_detail.season_number", season.seasonNumber)
            : tr("media_detail.specials")
        if activeSeasonId == season.id {
            Button(label) { activeSeasonId = season.id }.buttonStyle(.borderedProminent)
        } else {
            Button(label) { activeSeasonId = season.id }.buttonStyle(.bordered)
        }
    }

    @ViewBuilder
    private func episodesRail(media: Media, season: Season) -> some View {
        Rail(title: nil, items: season.episodes.sorted { $0.episodeNumber < $1.episodeNumber }) { ep in
            MediaCard(imagePath: ep.stillUrl, title: "E\(ep.episodeNumber)", subtitle: ep.title, portrait: false) {
                guard ep.hasFile, let file = media.files?.first(where: { $0.episodeId == ep.id }) else { return }
                onPlay(file.id, ep.id, 0)
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
        async let castTask: [MediaCastEntry] = APIClient.shared.get("/api/media/\(mediaId)/cast")
        async let resumeTask: MediaResumeInfo? = APIClient.shared.get("/api/playback/media/\(mediaId)")
        async let likeTask: LikeState = APIClient.shared.get("/api/likes/state/\(mediaId)")
        if let c = try? await castTask { cast = c }
        if let r = try? await resumeTask { resumeInfo = r }
        if let l = try? await likeTask { liked = l.media }
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
