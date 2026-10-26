import Foundation

struct PartyUser: Codable, Equatable {
    let userId: Int
    let username: String
}

struct PartyItem: Codable, Equatable {
    let mediaId: Int
    let mediaFileId: Int?
    let episodeId: Int?
    let title: String
    let posterUrl: String?
    let fanartUrl: String?
}

struct PartyAnchor: Codable, Equatable {
    let position: Double
    let serverTimeMs: Double
}

struct PartyMember: Codable, Equatable, Identifiable {
    let userId: Int
    let username: String
    let deviceId: String
    let role: String
    let status: String
    let deviceName: String?

    var id: String { "\(userId)#\(deviceId)" }
    var isHost: Bool { role == "host" }
}

struct PartyMessage: Codable, Equatable, Identifiable {
    struct System: Codable, Equatable {
        struct Args: Codable, Equatable {
            let position: Double?
            let title: String?
            let username: String?
        }
        let kind: String
        let by: String?
        let args: Args?
    }
    let id: Int
    let userId: Int?
    let username: String?
    let text: String
    let system: System?
}

/// What plays; absent before the host starts the party.
struct PartyPlayback: Codable, Equatable {
    let state: String
    let anchor: PartyAnchor
}

struct PartyLive: Codable, Equatable {
    let rev: Int
    let playback: PartyPlayback?
    let members: [PartyMember]
    let messages: [PartyMessage]
}

struct PartyPlaylistRef: Codable, Equatable {
    let id: Int
    let name: String
}

struct PartyGuest: Codable, Equatable {
    let userId: Int
    let username: String
    /// "invite" or "link".
    let source: String
}

struct SocialUser: Codable, Equatable, Identifiable {
    let id: Int
    let username: String
}

/// `PartySummaryDto` and `PartyDto` in one: the summary list leaves the trailing fields out.
struct Party: Codable, Equatable, Identifiable {
    let id: Int
    var name: String
    let status: String
    let scheduledAt: Date?
    let lobbyOpensAt: Date?
    let host: PartyUser
    /// The playing item, else the film chosen for the start; nil while none is chosen.
    var item: PartyItem?
    let playlist: PartyPlaylistRef?
    let memberCount: Int
    var policy: String?
    var reactionsEnabled: Bool?
    var chatEnabled: Bool?
    var linkSharing: Bool?
    var inviteToken: String?
    var guests: [PartyGuest]?
    var live: PartyLive?
}

/// What the engine follows: the last applied `party.state`, or the snapshot's equivalent.
struct PartyLiveState: Equatable {
    var rev: Int
    var state: String
    var item: PartyItem
    var anchor: PartyAnchor
    var whenMs: Double?
}

struct PartyStateEvent: Codable {
    let partyId: Int
    let rev: Int
    let state: String
    let item: PartyItem
    let anchor: PartyAnchor
    let whenMs: Double?
}

enum PartyEvent {
    case state(PartyStateEvent)
    case selection(partyId: Int, rev: Int, item: PartyItem)
    case members(partyId: Int, rev: Int, members: [PartyMember])
    case settings(partyId: Int, rev: Int, name: String, policy: String, reactionsEnabled: Bool, chatEnabled: Bool, linkSharing: Bool)
    case message(partyId: Int, message: PartyMessage)
    case reaction(partyId: Int, username: String, emoji: String)
    case closed(partyId: Int, reason: String)
    case invited(partyId: Int, name: String)
    case starting(partyId: Int, name: String)
    case updated(partyId: Int)

    private struct Head: Decodable { let type: String }
    private struct Selection: Decodable { let partyId: Int; let rev: Int; let item: PartyItem }
    private struct Members: Decodable { let partyId: Int; let rev: Int; let members: [PartyMember] }
    private struct Settings: Decodable {
        let partyId: Int; let rev: Int; let name: String; let policy: String
        let reactionsEnabled: Bool; let chatEnabled: Bool; let linkSharing: Bool
    }
    private struct Message: Decodable { let partyId: Int; let message: PartyMessage }
    private struct Reaction: Decodable { let partyId: Int; let username: String; let emoji: String }
    private struct Closed: Decodable { let partyId: Int; let reason: String }
    private struct Named: Decodable { let partyId: Int; let name: String? }

    /// Nil for any event that is not a party one, or that does not parse.
    static func decode(_ data: Data) -> PartyEvent? {
        let d = JSONDecoder.fliks
        guard let head = try? d.decode(Head.self, from: data), head.type.hasPrefix("party.") else { return nil }
        switch head.type {
        case "party.state":
            return (try? d.decode(PartyStateEvent.self, from: data)).map { .state($0) }
        case "party.selection":
            return (try? d.decode(Selection.self, from: data)).map { .selection(partyId: $0.partyId, rev: $0.rev, item: $0.item) }
        case "party.members":
            return (try? d.decode(Members.self, from: data)).map { .members(partyId: $0.partyId, rev: $0.rev, members: $0.members) }
        case "party.settings":
            return (try? d.decode(Settings.self, from: data)).map {
                .settings(partyId: $0.partyId, rev: $0.rev, name: $0.name, policy: $0.policy,
                          reactionsEnabled: $0.reactionsEnabled, chatEnabled: $0.chatEnabled, linkSharing: $0.linkSharing)
            }
        case "party.message":
            return (try? d.decode(Message.self, from: data)).map { .message(partyId: $0.partyId, message: $0.message) }
        case "party.reaction":
            return (try? d.decode(Reaction.self, from: data)).map { .reaction(partyId: $0.partyId, username: $0.username, emoji: $0.emoji) }
        case "party.closed":
            return (try? d.decode(Closed.self, from: data)).map { .closed(partyId: $0.partyId, reason: $0.reason) }
        case "party.invited":
            return (try? d.decode(Named.self, from: data)).map { .invited(partyId: $0.partyId, name: $0.name ?? "") }
        case "party.starting":
            return (try? d.decode(Named.self, from: data)).map { .starting(partyId: $0.partyId, name: $0.name ?? "") }
        case "party.updated":
            return (try? d.decode(Named.self, from: data)).map { .updated(partyId: $0.partyId) }
        default:
            return nil
        }
    }
}

extension Party {
    /// Host and member count when live, else host and start time; plus the playlist it follows.
    var cardSubtitle: String {
        let base: String
        if status == "live" {
            let key = memberCount == 1 ? "party.card_live_one" : "party.card_live_other"
            base = trp(key, ["host": host.username, "count": String(memberCount)])
        } else {
            let when = scheduledAt.map(PartyDate.text) ?? ""
            base = trp("party.card_scheduled", ["when": when, "host": host.username])
        }
        guard let playlist else { return base }
        return "\(base) · \(trp("party.playlist_label", ["name": playlist.name]))"
    }
}
