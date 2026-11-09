import Foundation

/// One song of the party's singer queue as the karaoke view lists it.
struct SingerQueueLine: Equatable, Identifiable {
    let id: Int
    let position: Int
    let title: String
    let singer: String
    /// The host plays any song now; its author or the host removes it.
    let canPlay: Bool
    let canRemove: Bool
}

/// The pending songs in the order the server states (`queuePosition`, 1 is next); films have no position.
func singerQueueLines(_ proposals: [PartyProposal], names: [Int: String], me: Int?, isHost: Bool) -> [SingerQueueLine] {
    proposals.compactMap { p in p.queuePosition.map { (p, $0) } }
        .sorted { $0.1 < $1.1 }
        .map { p, position in
            SingerQueueLine(id: p.id, position: position, title: p.item.title, singer: names[p.proposedBy] ?? "",
                            canPlay: isHost, canRemove: isHost || p.proposedBy == me)
        }
}
