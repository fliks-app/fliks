import XCTest
@testable import FliksTV

final class PartyEventTests: XCTestCase {
    private func decode(_ json: String) -> PartyEvent? { PartyEvent.decode(Data(json.utf8)) }

    private let item = #"{"mediaId":7,"mediaFileId":null,"episodeId":3,"title":"Show S01E03","posterUrl":null,"fanartUrl":null,"additionalFanartUrls":[],"hidden":false}"#

    func testStateEventWithAScheduledStart() {
        let json = #"{"type":"party.state","partyId":5,"rev":12,"state":"playing","item":\#(item),"anchor":{"position":42.5,"serverTimeMs":1700000000123},"whenMs":1700000000123,"by":{"userId":1,"username":"a"},"action":"play"}"#
        guard case let .state(e)? = decode(json) else { return XCTFail("not a state event") }
        XCTAssertEqual(e.partyId, 5)
        XCTAssertEqual(e.rev, 12)
        XCTAssertEqual(e.state, "playing")
        XCTAssertEqual(e.item.episodeId, 3)
        XCTAssertEqual(e.anchor.position, 42.5)
        XCTAssertEqual(e.whenMs, 1_700_000_000_123)
    }

    func testStateEventWithNoScheduledStart() {
        let json = #"{"type":"party.state","partyId":5,"rev":1,"state":"paused","item":\#(item),"anchor":{"position":0,"serverTimeMs":0},"whenMs":null,"by":null,"action":null}"#
        guard case let .state(e)? = decode(json) else { return XCTFail("not a state event") }
        XCTAssertNil(e.whenMs)
    }

    func testMembersEvent() {
        let json = #"{"type":"party.members","partyId":5,"rev":3,"members":[{"userId":1,"username":"a","deviceId":"d#party","role":"host","status":"ready","deviceName":null,"formFactor":"tv","voice":null}]}"#
        guard case let .members(partyId, rev, members)? = decode(json) else { return XCTFail("not a members event") }
        XCTAssertEqual([partyId, rev], [5, 3])
        XCTAssertTrue(members[0].isHost)
    }

    func testMessageEventWithASystemMessage() {
        let json = #"{"type":"party.message","partyId":5,"message":{"id":9,"userId":null,"username":null,"text":"","system":{"kind":"seeked","by":"a","args":{"position":61.0}},"sentAtMs":1}}"#
        guard case let .message(_, message)? = decode(json) else { return XCTFail("not a message event") }
        XCTAssertEqual(message.system?.kind, "seeked")
        XCTAssertEqual(message.system?.args?.position, 61)
    }

    func testClosedEvent() {
        guard case let .closed(partyId, reason)? = decode(#"{"type":"party.closed","partyId":5,"reason":"kicked"}"#) else {
            return XCTFail("not a closed event")
        }
        XCTAssertEqual([String(partyId), reason], ["5", "kicked"])
    }

    func testEventsThatAreNotPartyOnesAreIgnored() {
        XCTAssertNil(decode(#"{"type":"queue.updated"}"#))
        XCTAssertNil(decode(#"{"type":"sse.connected","connectionId":"x"}"#))
        XCTAssertNil(decode(#"{"type":"party.signal","partyId":5}"#))
        XCTAssertNil(decode("not json"))
    }

    func testSnapshotDecodesWithItsLiveState() throws {
        let json = #"{"id":5,"name":"Night","status":"scheduled","scheduledAt":"2026-10-25T20:00:00.000Z","host":{"userId":1,"username":"a"},"item":\#(item),"playlist":null,"memberCount":1,"policy":"everyone","reactionsEnabled":true,"chatEnabled":true,"linkSharing":true,"inviteToken":"tok","guests":[],"live":{"rev":4,"playback":{"state":"paused","anchor":{"position":0,"serverTimeMs":0}},"members":[],"messages":[]}}"#
        let party = try JSONDecoder.fliks.decode(Party.self, from: Data(json.utf8))
        XCTAssertEqual(party.live?.rev, 4)
        XCTAssertEqual(party.live?.playback?.state, "paused")
        XCTAssertEqual(party.inviteToken, "tok")
        XCTAssertNotNil(party.scheduledAt)
    }

    func testSummaryWithoutTheTrailingFieldsDecodes() throws {
        let json = #"{"id":5,"name":"Night","status":"live","scheduledAt":null,"host":{"userId":1,"username":"a"},"item":\#(item),"playlist":{"id":2,"name":"P"},"memberCount":3}"#
        let party = try JSONDecoder.fliks.decode(Party.self, from: Data(json.utf8))
        XCTAssertNil(party.live)
        XCTAssertEqual(party.playlist?.id, 2)
    }

    func testRoomWithoutAFilmDecodesWithNoItemAndNoPlayback() throws {
        let json = #"{"id":5,"name":"Night","status":"scheduled","scheduledAt":null,"host":{"userId":1,"username":"a"},"item":null,"playlist":null,"memberCount":1,"live":{"rev":4,"playback":null,"members":[],"messages":[]}}"#
        let party = try JSONDecoder.fliks.decode(Party.self, from: Data(json.utf8))
        XCTAssertNil(party.item)
        XCTAssertNotNil(party.live)
        XCTAssertNil(party.live?.playback)
    }

    func testProgrammeEvent() {
        guard case let .programme(partyId, rev, item)? = decode(#"{"type":"party.programme","partyId":5,"rev":6,"item":\#(item)}"#) else {
            return XCTFail("not a programme event")
        }
        XCTAssertEqual([partyId, rev], [5, 6])
        XCTAssertEqual(item?.mediaId, 7)
    }

    func testProgrammeEventAfterTheStartHasNoItem() {
        guard case let .programme(_, _, item)? = decode(#"{"type":"party.programme","partyId":5,"rev":7,"item":null}"#) else {
            return XCTFail("not a programme event")
        }
        XCTAssertNil(item)
    }

    private let hiddenItem = #"{"mediaId":8,"mediaFileId":null,"episodeId":null,"title":"","posterUrl":null,"fanartUrl":null,"additionalFanartUrls":[],"hidden":true}"#

    func testProposalsEventKeepsAMaskedRowNeutral() {
        let json = #"{"type":"party.proposals","partyId":5,"proposals":[{"id":2,"item":\#(item),"proposedBy":1,"upvoterIds":[1,3],"downvoterIds":[]},{"id":3,"item":\#(hiddenItem),"proposedBy":3,"upvoterIds":[3],"downvoterIds":[]}]}"#
        guard case let .proposals(partyId, list)? = decode(json) else { return XCTFail("not a proposals event") }
        XCTAssertEqual(partyId, 5)
        XCTAssertEqual(list.map(\.score), [2, 1])
        XCTAssertFalse(list[0].item.hidden)
        XCTAssertTrue(list[1].item.hidden)
        XCTAssertEqual(list[1].item.shownTitle, tr("party.proposal_hidden"))
    }

    func testProposalsSortByVotesThenOldest() {
        func proposal(_ id: Int, _ votes: Int) -> PartyProposal {
            let item = try! JSONDecoder.fliks.decode(PartyItem.self, from: Data(hiddenItem.utf8))
            return PartyProposal(id: id, item: item, proposedBy: 1, upvoterIds: Array(0..<votes), downvoterIds: [])
        }
        XCTAssertEqual(PartyProposal.sorted([proposal(1, 1), proposal(2, 3), proposal(3, 3), proposal(4, 0)]).map(\.id), [2, 3, 1, 4])
    }

    func testProposalsRankFewestDownvotesAmongEqualUpvotes() {
        func proposal(_ id: Int, up: Int, down: Int) -> PartyProposal {
            let item = try! JSONDecoder.fliks.decode(PartyItem.self, from: Data(hiddenItem.utf8))
            return PartyProposal(id: id, item: item, proposedBy: 1, upvoterIds: Array(0..<up), downvoterIds: Array(0..<down))
        }
        let list = [proposal(1, up: 3, down: 2), proposal(2, up: 3, down: 0), proposal(3, up: 1, down: 0)]
        XCTAssertEqual(PartyProposal.sorted(list).map(\.id), [2, 1, 3])
        XCTAssertEqual(PartyProposal.top(list)?.id, 2)
        XCTAssertNil(PartyProposal.top([proposal(1, up: 2, down: 1), proposal(2, up: 2, down: 1)]))
    }

    func testSnapshotCarriesItsProposals() throws {
        let json = #"{"id":5,"name":"Night","status":"scheduled","scheduledAt":null,"host":{"userId":1,"username":"a"},"item":null,"playlist":null,"memberCount":1,"proposals":[{"id":2,"item":\#(item),"proposedBy":1,"upvoterIds":[1],"downvoterIds":[]}],"live":{"rev":4,"playback":null,"members":[],"messages":[]}}"#
        let party = try JSONDecoder.fliks.decode(Party.self, from: Data(json.utf8))
        XCTAssertEqual(party.proposals?.count, 1)
    }
}
