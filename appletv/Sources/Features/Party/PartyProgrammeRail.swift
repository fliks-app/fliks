import SwiftUI

/// The party's programme as a rail of landscape cards, numbered in play order; the host gets the editor button.
struct PartyProgrammeRail: View {
    let items: [PartyItem]
    let canEdit: Bool
    @Environment(PartyService.self) private var service

    private struct Row: Identifiable {
        let id: Int
        let item: PartyItem
    }

    var body: some View {
        let rows = items.enumerated().map { Row(id: $0.offset, item: $0.element) }
        VStack(alignment: .leading, spacing: 10) {
            Text(tr("party.programme")).font(.headline).foregroundStyle(.secondary)
            if canEdit {
                Button { service.sheet = .programme } label: { Label(tr("party.programme"), systemImage: "list.number") }
                    .buttonStyle(.bordered)
            }
            if rows.isEmpty {
                Text(tr(canEdit ? "party.programme_empty_host" : "party.programme_empty"))
                    .font(.callout).foregroundStyle(.secondary)
            } else {
                Rail(title: nil, items: rows) { row in
                    MediaCard(imagePath: row.item.cardImage, title: row.item.cardTitle, subtitle: row.item.cardSubtitle,
                              portrait: false, backdropPath: row.item.hidden ? nil : row.item.fanartUrl,
                              cornerLabel: String(row.id + 1)) {}
                }
            }
        }
    }
}
