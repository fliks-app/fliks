import SwiftUI

/// The party's singer queue under the karaoke stage, from the party's proposals.
struct KaraokeQueueView: View {
    @State private var party = PartyService.shared

    private var lines: [SingerQueueLine] {
        var names = Dictionary(party.members.map { ($0.userId, $0.username) }, uniquingKeysWith: { a, _ in a })
        for g in party.party?.guests ?? [] { names[g.userId] = g.username }
        if let host = party.party?.host { names[host.userId] = host.username }
        return singerQueueLines(party.proposals, names: names, me: AuthService.shared.currentUser?.id, isHost: party.isHost)
    }

    var body: some View {
        SingerQueuePanel(lines: lines, isHost: party.isHost,
                         onPlay: { id in Task { await party.playSinger(id) } },
                         onRemove: { id in Task { await party.removeProposal(id) } })
    }
}

/// Who sings next, the order after, and for the host playing a song now. A song's author or the host removes it.
struct SingerQueuePanel: View {
    let lines: [SingerQueueLine]
    let isHost: Bool
    var onPlay: (Int?) -> Void
    var onRemove: (Int) -> Void
    @State private var picked: SingerQueueLine?

    var body: some View {
        let list = lines
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 24) {
                Text(tr("karaoke.queue_title")).font(.headline)
                if let next = list.first {
                    Text(trp("karaoke.queue_next", ["name": next.singer, "title": next.title])).font(.callout).lineLimit(1)
                } else {
                    Text(tr("karaoke.queue_empty")).font(.callout).foregroundStyle(.secondary)
                }
                Spacer()
                if isHost, !list.isEmpty {
                    Button { onPlay(nil) } label: {
                        Label(tr("karaoke.queue_play_next"), systemImage: "play.fill")
                    }
                }
            }
            if !list.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 20) {
                        ForEach(list) { line in
                            Button { picked = line } label: {
                                HStack(spacing: 12) {
                                    Text("\(line.position)").font(.callout.monospacedDigit()).foregroundStyle(.secondary)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(line.title).font(.callout.bold()).lineLimit(1)
                                        Text(line.singer).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                    }
                                }
                                .frame(maxWidth: 360, alignment: .leading)
                            }
                            .disabled(!line.canPlay && !line.canRemove)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 18)
                }
                .focusSection()
            }
        }
        .buttonStyle(.bordered)
        .confirmationDialog(picked?.title ?? "", isPresented: Binding(get: { picked != nil }, set: { if !$0 { picked = nil } }),
                            titleVisibility: .visible, presenting: picked) { line in
            if line.canPlay {
                Button(trp("karaoke.queue_play_now", ["title": line.title])) { onPlay(line.id) }
            }
            if line.canRemove {
                Button(trp("karaoke.queue_cancel", ["title": line.title]), role: .destructive) { onRemove(line.id) }
            }
        }
    }
}
