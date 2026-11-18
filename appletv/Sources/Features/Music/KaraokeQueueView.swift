import SwiftUI

/// The next rows of the party's programme under the karaoke stage, each with its singer; hidden while none waits.
struct KaraokeQueueView: View {
    @State private var party = PartyService.shared

    private func singer(_ row: PartyItem) -> String {
        guard let id = row.addedBy else { return "" }
        if let m = party.members.first(where: { $0.userId == id }) { return m.username }
        if let g = party.party?.guests?.first(where: { $0.userId == id }) { return g.username }
        return party.party?.host.userId == id ? party.party?.host.username ?? "" : ""
    }

    var body: some View {
        let rows = party.upNext
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 14) {
                Text(tr("party.programme")).font(.headline)
                HStack(spacing: 40) {
                    ForEach(rows) { row in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(row.shownTitle).font(.callout.bold()).lineLimit(1)
                            Text(singer(row)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                        .frame(maxWidth: 360, alignment: .leading)
                    }
                }
            }
        }
    }
}
