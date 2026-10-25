import XCTest
@testable import FliksTV

final class PartyPeopleTests: XCTestCase {
    private let host = PartyUser(userId: 1, username: "host")
    private func member(_ id: Int, _ status: String = "ready") -> PartyMember {
        PartyMember(userId: id, username: "u\(id)", deviceId: "d", role: "member", status: status, deviceName: nil)
    }

    func testCandidatesExcludeTheHostAndEveryGuest() {
        let following = [SocialUser(id: 1, username: "host"), .init(id: 2, username: "a"), .init(id: 3, username: "b"), .init(id: 4, username: "c")]
        let guests = [PartyGuest(userId: 2, username: "a", source: "invite"), .init(userId: 3, username: "b", source: "link")]
        XCTAssertEqual(PartyPeople.candidates(following: following, host: host, guests: guests).map(\.id), [4])
    }

    func testPeopleListHostFirstWithKindAndPresence() {
        let guests = [PartyGuest(userId: 2, username: "a", source: "invite"), .init(userId: 3, username: "b", source: "link")]
        let people = PartyPeople.people(host: host, guests: guests, members: [member(1), member(3), member(2, "away")])
        XCTAssertEqual(people.map(\.kind), [.host, .invited, .link])
        XCTAssertEqual(people.map(\.present), [true, false, true])
    }

    func testTheHostIsNotListedTwiceWhenAlsoAGuest() {
        let guests = [PartyGuest(userId: 1, username: "host", source: "invite")]
        XCTAssertEqual(PartyPeople.people(host: host, guests: guests, members: []).count, 1)
    }

    func testSnapshotGuestsDecode() throws {
        let json = #"{"id":5,"name":"N","status":"live","scheduledAt":null,"lobbyOpensAt":null,"host":{"userId":1,"username":"a"},"item":{"mediaId":7,"mediaFileId":null,"episodeId":null,"title":"T","posterUrl":null,"fanartUrl":null},"playlist":null,"memberCount":1,"guests":[{"userId":2,"username":"b","source":"invite"}]}"#
        let party = try JSONDecoder.fliks.decode(Party.self, from: Data(json.utf8))
        XCTAssertEqual(party.guests?.first?.source, "invite")
    }

    func testPendingAreGuestsWithNoConnectedMember() {
        let guests = [PartyGuest(userId: 1, username: "host", source: "invite"), .init(userId: 2, username: "a", source: "invite"),
                      .init(userId: 3, username: "b", source: "link"), .init(userId: 4, username: "c", source: "invite")]
        let pending = PartyPeople.pending(host: host, guests: guests, members: [member(3), member(4, "away")])
        XCTAssertEqual(pending.map(\.userId), [2, 4])
    }
}
