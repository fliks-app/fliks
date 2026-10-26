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
    /// Episode fields, nil for a movie (and all blank when `hidden`).
    var stillUrl: String? = nil
    var seriesTitle: String? = nil
    var seasonNumber: Int? = nil
    var episodeNumber: Int? = nil
    var episodeTitle: String? = nil
    /// The viewer cannot open the media: title and artwork are blank, the ids stay.
    let hidden: Bool
}

extension PartyItem: Identifiable {
    var id: String { "\(mediaId).\(episodeId ?? 0)" }
}

extension PartyItem {
    /// The title (`Title S01E02` for an episode), or the neutral line of a masked row.
    var shownTitle: String { hidden ? tr("party.proposal_hidden") : title }

    /// The series title for an episode, else the title: the Continue Watching card's title.
    var cardTitle: String { hidden ? tr("party.proposal_hidden") : (seriesTitle ?? title) }
    /// What a removal names: the episode for an episode, the film otherwise.
    var itemName: String { cardSubtitle ?? cardTitle }

    /// "S01E02 - Episode title" like the Continue Watching card; nil for a movie or a masked row.
    var cardSubtitle: String? {
        guard !hidden, let season = seasonNumber, let number = episodeNumber else { return nil }
        let label = String(format: "S%02dE%02d", season, number)
        guard let episodeTitle, !episodeTitle.isEmpty else { return label }
        return "\(label) - \(episodeTitle)"
    }

    /// Still, then fanart, then poster; nothing for a masked row.
    var cardImage: String? { hidden ? nil : (stillUrl ?? fanartUrl ?? posterUrl) }
}

/// A film suggested for the start; read-only on the TV.
struct PartyProposal: Codable, Equatable, Identifiable {
    let id: Int
    let item: PartyItem
    let proposedBy: Int
    let upvoterIds: [Int]
    let downvoterIds: [Int]
    var score: Int { upvoterIds.count - downvoterIds.count }

    /// Best score (ups minus downs) first, the oldest (lowest id) among equals: how the server picks the start.
    static func sorted(_ list: [PartyProposal]) -> [PartyProposal] {
        list.sorted { $0.score != $1.score ? $0.score > $1.score : $0.id < $1.id }
    }
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
    var proposals: [PartyProposal]?
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
    case programme(partyId: Int, rev: Int, item: PartyItem?)
    case members(partyId: Int, rev: Int, members: [PartyMember])
    case settings(partyId: Int, rev: Int, name: String, policy: String, reactionsEnabled: Bool, chatEnabled: Bool, linkSharing: Bool)
    case message(partyId: Int, message: PartyMessage)
    case reaction(partyId: Int, username: String, emoji: String)
    case closed(partyId: Int, reason: String)
    case invited(partyId: Int, name: String)
    case starting(partyId: Int, name: String)
    case updated(partyId: Int)
    case proposals(partyId: Int, proposals: [PartyProposal])

    private struct Head: Decodable { let type: String }
    private struct Programme: Decodable { let partyId: Int; let rev: Int; let item: PartyItem? }
    private struct Members: Decodable { let partyId: Int; let rev: Int; let members: [PartyMember] }
    private struct Settings: Decodable {
        let partyId: Int; let rev: Int; let name: String; let policy: String
        let reactionsEnabled: Bool; let chatEnabled: Bool; let linkSharing: Bool
    }
    private struct Message: Decodable { let partyId: Int; let message: PartyMessage }
    private struct Reaction: Decodable { let partyId: Int; let username: String; let emoji: String }
    private struct Closed: Decodable { let partyId: Int; let reason: String }
    private struct Proposals: Decodable { let partyId: Int; let proposals: [PartyProposal] }
    private struct Named: Decodable { let partyId: Int; let name: String? }

    /// Nil for any event that is not a party one, or that does not parse.
    static func decode(_ data: Data) -> PartyEvent? {
        let d = JSONDecoder.fliks
        guard let head = try? d.decode(Head.self, from: data), head.type.hasPrefix("party.") else { return nil }
        switch head.type {
        case "party.state":
            return (try? d.decode(PartyStateEvent.self, from: data)).map { .state($0) }
        case "party.programme":
            return (try? d.decode(Programme.self, from: data)).map { .programme(partyId: $0.partyId, rev: $0.rev, item: $0.item) }
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
        case "party.proposals":
            return (try? d.decode(Proposals.self, from: data)).map { .proposals(partyId: $0.partyId, proposals: $0.proposals) }
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

/// What the create sheet starts from: a film or episode, a playlist, or nothing (the Home entry).
struct PartyCreateTarget: Equatable {
    var name = ""
    var mediaId: Int?
    var mediaFileId: Int?
    var episodeId: Int?
    var playlistId: Int?
}

/// `POST /api/parties`; nil fields stay out of the body.
struct PartyCreateRequest: Encodable {
    var name: String
    var mediaId: Int?
    var mediaFileId: Int?
    var episodeId: Int?
    var playlistId: Int?
    var scheduledAt: String?
    var policy: String?
    var reactionsEnabled: Bool?
    var chatEnabled: Bool?
    var linkSharing: Bool?
    var inviteeIds: [Int]?

    static func iso(_ date: Date) -> String { ISO8601DateFormatter().string(from: date) }
}
