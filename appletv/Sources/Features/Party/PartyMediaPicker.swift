import SwiftUI

struct PartyPick: Equatable {
    let mediaId: Int
    let episodeId: Int?
    let title: String
}

/// Search the library with the system keyboard. A film is picked at once; a series asks for its episodes, and
/// with `multi` (the programme) for how many: one, until the end of the season, the season, or several.
struct PartyMediaPicker: View {
    var multi = false
    var onPick: ([PartyPick]) -> Void
    var onCancel: () -> Void

    private enum Mode: CaseIterable {
        case this, untilEnd, season, several
        var label: String {
            switch self {
            case .this: return tr("media_picker.mode_this")
            case .untilEnd: return tr("media_picker.mode_until_end")
            case .season: return tr("media_picker.mode_season")
            case .several: return tr("media_picker.mode_multiple")
            }
        }
        var hint: String? {
            switch self {
            case .this: return tr("media_picker.hint_this")
            case .untilEnd: return tr("media_picker.hint_until_end")
            case .season: return nil
            case .several: return tr("media_picker.hint_multiple")
            }
        }
    }

    @State private var query = ""
    @State private var results: [Media] = []
    @State private var series: Media?
    @State private var seasonId: Int?
    @State private var mode = Mode.this
    @State private var ticked: [Int] = []
    @State private var searchTask: Task<Void, Never>?

    var body: some View {
        PartySheetPage(title: series?.title ?? tr("media_picker.title")) {
            if let series { episodes(of: series) } else { search }
        } bar: {
            HStack(spacing: 30) {
                if let series, mode == .several, !ticked.isEmpty {
                    Button(trp(ticked.count == 1 ? "media_picker.add_count_one" : "media_picker.add_count_other",
                               ["count": String(ticked.count)])) {
                        onPick(ticked.compactMap { id in episodeList(series).first { $0.1.id == id } }.map { pick(series, $0.1) })
                    }
                    .buttonStyle(.borderedProminent)
                }
                Button(tr(series == nil ? "party.tv_close" : "media_picker.back")) {
                    if series == nil { onCancel() } else { series = nil; ticked = []; mode = .this }
                }
                .buttonStyle(.bordered)
            }
            .focusSection()
        }
    }

    private var search: some View {
        VStack(spacing: 24) {
            TextField(tr("media_picker.search_placeholder"), text: $query)
                .frame(maxWidth: 1200)
                .onChange(of: query) { _, _ in scheduleSearch() }
            if query.isEmpty { Text(tr("media_picker.hint")).font(.callout).foregroundStyle(.secondary) }
            ScrollView {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 200, maximum: 240), spacing: 30, alignment: .top)], spacing: 30) {
                    ForEach(results) { media in
                        PosterCard(imagePath: media.posterUrl, title: media.title, missing: media.isMissing) { choose(media) }
                    }
                }
                .padding(30)
            }
        }
    }

    private func seasons(_ media: Media) -> [Season] { (media.seasons ?? []).sorted { $0.seasonNumber < $1.seasonNumber } }

    /// Playable episodes of the shown season, in order.
    private func episodeList(_ media: Media) -> [(Season, Episode)] {
        guard let season = seasons(media).first(where: { $0.id == seasonId }) ?? seasons(media).first else { return [] }
        return season.episodes.filter(\.hasFile).sorted { $0.episodeNumber < $1.episodeNumber }.map { (season, $0) }
    }

    private func pick(_ media: Media, _ episode: Episode) -> PartyPick { PartyPick(mediaId: media.id, episodeId: episode.id, title: media.title) }

    private func episodes(of media: Media) -> some View {
        let rows = episodeList(media)
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                if multi {
                    Picker(tr("media_picker.mode_label"), selection: $mode) {
                        ForEach(Mode.allCases, id: \.self) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    if let hint = mode.hint { Text(hint).font(.callout).foregroundStyle(.secondary) }
                }
                if seasons(media).count > 1 {
                    Picker("", selection: Binding(get: { seasonId ?? seasons(media).first?.id }, set: { seasonId = $0; ticked = [] })) {
                        ForEach(seasons(media)) { Text(String(format: "S%02d", $0.seasonNumber)).tag(Optional($0.id)) }
                    }
                }
                if rows.isEmpty { Text(tr("media_picker.no_episodes")).foregroundStyle(.secondary) }
                if mode == .season, !rows.isEmpty {
                    Button(tr("media_picker.mode_season")) { onPick(rows.map { pick(media, $0.1) }) }
                        .buttonStyle(.borderedProminent)
                } else {
                    ForEach(Array(rows.enumerated()), id: \.1.1.id) { index, row in
                        let label = EpisodeDetailView.episodeLabel(season: row.0, episode: row.1)
                        Button {
                            tap(media, rows, index)
                        } label: {
                            HStack {
                                Text(label)
                                if mode == .several, ticked.contains(row.1.id) { Spacer(); Image(systemName: "checkmark") }
                            }
                        }
                        .buttonStyle(.bordered)
                    }
                }
            }
            .frame(maxWidth: 1200, alignment: .leading)
            .padding(30)
        }
    }

    private func tap(_ media: Media, _ rows: [(Season, Episode)], _ index: Int) {
        switch mode {
        case .this: onPick([pick(media, rows[index].1)])
        case .untilEnd: onPick(rows[index...].map { pick(media, $0.1) })
        case .season: break
        case .several:
            let id = rows[index].1.id
            if let at = ticked.firstIndex(of: id) { ticked.remove(at: at) } else { ticked.append(id) }
        }
    }

    private func choose(_ media: Media) {
        guard media.type == "series" else { return onPick([PartyPick(mediaId: media.id, episodeId: nil, title: media.title)]) }
        Task {
            // The search rows carry no episodes: fetch the full series.
            let full: Media = (try? await APIClient.shared.get("/api/media/\(media.id)")) ?? media
            seasonId = seasons(full).first?.id
            series = full
        }
    }

    private func scheduleSearch() {
        searchTask?.cancel()
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { results = []; return }
        searchTask = Task {
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard !Task.isCancelled else { return }
            let res: Paginated<Media>? = try? await APIClient.shared.get("/api/media", query: ["q": q, "page": "1", "limit": "30"])
            guard !Task.isCancelled else { return }
            results = res?.data ?? []
        }
    }
}
