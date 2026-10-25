import Foundation

/// The invite and people lists of the party screens, pure so they are unit-tested.
enum PartyPeople {
    struct Person: Equatable, Identifiable {
        enum Kind: Equatable { case host, invited, link }
        let userId: Int
        let username: String
        let kind: Kind
        /// In the live party right now.
        let present: Bool
        var id: Int { userId }
    }

    /// Who can still be invited: the users the caller follows, minus the host and every guest.
    static func candidates(following: [SocialUser], host: PartyUser, guests: [PartyGuest]) -> [SocialUser] {
        let taken = Set([host.userId] + guests.map(\.userId))
        return following.filter { !taken.contains($0.id) }
    }

    /// The host first, then every guest, each marked present when a member of that user is connected.
    static func people(host: PartyUser, guests: [PartyGuest], members: [PartyMember]) -> [Person] {
        let present = Set(members.filter { $0.status != "away" }.map(\.userId))
        let hostRow = Person(userId: host.userId, username: host.username, kind: .host, present: present.contains(host.userId))
        let rows = guests.filter { $0.userId != host.userId }.map {
            Person(userId: $0.userId, username: $0.username, kind: $0.source == "link" ? .link : .invited,
                   present: present.contains($0.userId))
        }
        return [hostRow] + rows
    }
}
