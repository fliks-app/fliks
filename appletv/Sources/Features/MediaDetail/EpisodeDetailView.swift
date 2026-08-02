import SwiftUI

/// Full page for one episode: still, S/E label, air date + runtime, synopsis,
/// play/resume, and the rest of its season.
struct EpisodeDetailView: View {
    let mediaId: Int
    let episodeId: Int
    var onPlay: (_ mediaFileId: Int, _ episodeId: Int?, _ startAt: Double) -> Void
    var onSelectEpisode: (_ episodeId: Int) -> Void

    private enum LoadState {
        case loading
        case loaded(Media)
        case failed
    }

    @State private var state: LoadState = .loading
    @State private var resumeInfo: MediaResumeInfo?
    @Environment(Backdrop.self) private var backdrop
    @Environment(WatchedStore.self) private var watched
    @Environment(PlaylistPicker.self) private var playlistPicker

    private var isWatched: Bool { watched.isWatched(mediaId: mediaId, episodeId: episodeId) }

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
                if let season = season(of: media), let episode = episode(in: season) {
                    content(media: media, season: season, episode: episode)
                } else {
                    Text(tr("media_detail.not_found"))
                        .font(.title3)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
        .task(id: episodeId) { await load() }
    }

    @ViewBuilder
    private func content(media: Media, season: Season, episode: Episode) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 40) {
                header(media: media, season: season, episode: episode)

                let others = season.episodes
                    .filter { $0.id != episode.id }
                    .sorted { $0.episodeNumber < $1.episodeNumber }
                if !others.isEmpty {
                    Rail(title: MediaDetailView.seasonLabel(season), items: others) { ep in
                        MediaCard(imagePath: ep.stillUrl, title: "E\(ep.episodeNumber)",
                                  subtitle: ep.title, portrait: false,
                                  mediaId: mediaId, episodeId: ep.id) {
                            onSelectEpisode(ep.id)
                        }
                        .opacity(ep.hasFile ? 1 : 0.4)
                    }
                }
            }
            .padding(.horizontal, 60)
            .padding(.vertical, 48)
        }
        .onAppear { backdrop.url = episode.stillUrl ?? media.fanartUrl ?? media.posterUrl }
    }

    @ViewBuilder
    private func header(media: Media, season: Season, episode: Episode) -> some View {
        HStack(alignment: .top, spacing: 44) {
            CachedAsyncImage(url: ImageURL.build(episode.stillUrl, size: .medium)) {
                Color.white.opacity(0.08)
            }
            .frame(width: 620, height: 349)
            .clipShape(RoundedRectangle(cornerRadius: 16))

            VStack(alignment: .leading, spacing: 18) {
                Text(media.title)
                    .font(.title3)
                    .foregroundStyle(.secondary)

                Text(Self.episodeLabel(season: season, episode: episode))
                    .font(.system(size: 40, weight: .bold))

                HStack(spacing: 16) {
                    if let aired = AppDate.medium(episode.airDate) { Text(aired) }
                    if let runtime = runtime(media: media, episode: episode), runtime > 0 {
                        Text(tr("media_detail.runtime_minutes", runtime))
                    }
                }
                .font(.callout)
                .foregroundStyle(.secondary)

                if let overview = episode.overview, !overview.isEmpty {
                    Text(overview)
                        .font(.body)
                        .lineLimit(6)
                }

                HStack(spacing: 20) {
                    if let fileId = media.fileId(episodeId: episode.id) {
                        let startAt = resumePosition(episode: episode)
                        Button(action: { onPlay(fileId, episode.id, startAt) }) {
                            Label(startAt > 0 ? tr("common.resume") : tr("common.play"),
                                  systemImage: "play.fill")
                        }
                        .buttonStyle(.borderedProminent)
                    }
                    Button {
                        Task { await watched.toggle(mediaId: mediaId, episodeId: episode.id) }
                    } label: {
                        Label(isWatched ? tr("media_card.mark_unwatched") : tr("media_card.mark_watched"),
                              systemImage: isWatched ? "eye.slash" : "checkmark.circle")
                    }
                    .buttonStyle(.bordered)
                    Button {
                        playlistPicker.open(mediaId: mediaId, episodeId: episode.id)
                    } label: {
                        Label(tr("playlists.add_to_playlist_title"), systemImage: "text.badge.plus")
                    }
                    .buttonStyle(.bordered)
                }
                .padding(.top, 8)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .focusSection()
    }

    private func season(of media: Media) -> Season? {
        media.seasons?.first { $0.episodes.contains { $0.id == episodeId } }
    }

    private func episode(in season: Season) -> Episode? {
        season.episodes.first { $0.id == episodeId }
    }

    private func resumePosition(episode: Episode) -> Double {
        guard let resumeInfo, resumeInfo.episodeId == episode.id else { return 0 }
        return resumeInfo.positionSeconds
    }

    /// The file duration beats the provider runtime: a multi-episode file
    /// (S07E25-E26) runs longer than what TMDB reports per episode.
    private func runtime(media: Media, episode: Episode) -> Int? {
        if let seconds = media.files?.first(where: { $0.episodeId == episode.id })?
            .streamInfo?.durationSeconds, seconds > 0 {
            return Int((seconds / 60).rounded())
        }
        return episode.runtime
    }

    static func episodeLabel(season: Season, episode: Episode) -> String {
        let number = String(format: "S%02d:E%02d", season.seasonNumber, episode.episodeNumber)
        let range = episode.endEpisodeNumber.flatMap { end in
            end > episode.episodeNumber ? String(format: "-E%02d", end) : nil
        } ?? ""
        guard let title = episode.title, !title.isEmpty else { return number + range }
        return "\(number)\(range) — \(title)"
    }

    private func load() async {
        state = .loading
        resumeInfo = nil
        do {
            let media: Media = try await APIClient.shared.get("/api/media/\(mediaId)")
            state = .loaded(media)
        } catch {
            state = .failed
            return
        }
        await watched.loadSeries(mediaId)
        resumeInfo = try? await APIClient.shared.get("/api/playback/media/\(mediaId)")
    }
}
