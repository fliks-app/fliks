import SwiftUI

/// The host's programme editor: reorder, remove and add (episodes in bulk). Every change is the whole list sent back.
struct PartyProgrammeView: View {
    @Environment(PartyService.self) private var service
    /// Nil until the programme was read: an edit sends the whole list, so a failed read must not be editable.
    @State private var loaded: [PartyItem]?
    @State private var adding = false
    @State private var busy = false
    @State private var removing: Int?

    private var items: [PartyItem] { loaded ?? [] }

    var body: some View {
        Group {
            if adding {
                PartyMediaPicker(multi: true, onPick: append, onCancel: { adding = false })
            } else {
                PartySheetPage(title: tr("party.programme")) {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 18) {
                            if loaded == nil {
                                Text(tr("error.generic")).foregroundStyle(.secondary)
                            } else if items.isEmpty {
                                Text(tr("party.programme_empty_host")).foregroundStyle(.secondary)
                            }
                            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                                row(index, item)
                            }
                        }
                        .frame(maxWidth: 1300)
                        .padding(30)
                    }
                    .focusSection()
                } bar: {
                    HStack(spacing: 30) {
                        if loaded == nil {
                            Button(tr("common.retry")) { Task { loaded = await service.fetchQueue() } }.buttonStyle(.borderedProminent)
                        } else {
                            Button(tr("party.programme_add")) { adding = true }.buttonStyle(.borderedProminent)
                        }
                        Button(tr("party.tv_close")) { service.sheet = nil }.buttonStyle(.bordered)
                    }
                    .frame(maxWidth: .infinity)
                    .focusSection()
                }
            }
        }
        .confirmationDialog(tr("party.programme_remove"), isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
                            titleVisibility: .visible) {
            Button(tr("party.programme_remove"), role: .destructive) {
                if let at = removing { save(items.enumerated().filter { $0.offset != at }.map(\.element)) }
            }
            Button(tr("common.cancel"), role: .cancel) {}
        } message: {
            Text(trp("party.programme_remove_message", ["title": removing.flatMap { items.indices.contains($0) ? items[$0].itemName : nil } ?? ""]))
        }
        .task { loaded = await service.fetchQueue() }
    }

    private func row(_ index: Int, _ item: PartyItem) -> some View {
        let playing = service.live != nil && service.item?.mediaId == item.mediaId && service.item?.episodeId == item.episodeId
        return HStack(spacing: 24) {
            Text(String(index + 1)).font(.callout).foregroundStyle(.secondary).frame(width: 40)
            PosterImage(path: item.cardImage)
                .frame(width: 160, height: 90).clipShape(RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 4) {
                Text(item.cardTitle).font(.callout.weight(.semibold)).lineLimit(1)
                if let sub = item.cardSubtitle { Text(sub).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                if playing { Text(tr("party.programme_now")).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer()
            HStack(spacing: 16) {
                button("chevron.up", "party.programme_up", disabled: index == 0) { move(index, -1) }
                button("chevron.down", "party.programme_down", disabled: index == items.count - 1) { move(index, 1) }
                button("trash", "party.programme_remove", disabled: false) { removing = index }
            }
            .focusSection()
        }
    }

    private func button(_ symbol: String, _ label: String, disabled: Bool, _ action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: symbol) }
            .buttonStyle(.bordered)
            .disabled(disabled || busy)
            .accessibilityLabel(tr(label))
    }

    private func move(_ index: Int, _ by: Int) {
        var next = items
        next.swapAt(index, index + by)
        save(next)
    }

    private func append(_ picks: [PartyPick]) {
        adding = false
        var next = items
        for pick in picks where !next.contains(where: { $0.mediaId == pick.mediaId && $0.episodeId == pick.episodeId }) {
            next.append(PartyItem(mediaId: pick.mediaId, mediaFileId: nil, episodeId: pick.episodeId, title: pick.title,
                                  posterUrl: nil, fanartUrl: nil, hidden: false))
        }
        save(next)
    }

    /// The list follows at once; the server's answer (titles, artwork) replaces it.
    private func save(_ next: [PartyItem]) {
        loaded = next
        busy = true
        Task {
            let saved = await service.setProgramme(next)
            loaded = await service.fetchQueue() ?? (saved ? next : nil)
            busy = false
        }
    }
}
