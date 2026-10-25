import XCTest
@testable import FliksTV

final class PartyChatTests: XCTestCase {
    func testReactionsAreCappedKeepingTheNewest() {
        var list: [FloatingReaction] = []
        for i in 0..<(PartyReactions.maxOnScreen + 3) {
            list = PartyReactions.appending(list, FloatingReaction(id: i, emoji: "x", username: "u", left: 0.5))
        }
        XCTAssertEqual(list.count, PartyReactions.maxOnScreen)
        XCTAssertEqual(list.first?.id, 3)
        XCTAssertEqual(list.last?.id, PartyReactions.maxOnScreen + 2)
    }

    func testClockFormatsMinutesAndHours() {
        XCTAssertEqual(PartyMessage.clock(61), "1:01")
        XCTAssertEqual(PartyMessage.clock(3725), "1:02:05")
        XCTAssertEqual(PartyMessage.clock(-4), "0:00")
    }

    func testReactionEventDecodes() {
        let json = #"{"type":"party.reaction","partyId":5,"userId":2,"username":"b","emoji":"🔥"}"#
        guard case let .reaction(partyId, username, emoji)? = PartyEvent.decode(Data(json.utf8)) else { return XCTFail("not a reaction") }
        XCTAssertEqual([String(partyId), username, emoji], ["5", "b", "🔥"])
    }
}
