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

    private func system(_ json: String) throws -> PartyMessage.System {
        try JSONDecoder.fliks.decode(PartyMessage.System.self, from: Data(json.utf8))
    }

    func testSystemKeysFollowTheWebMapping() throws {
        func key(_ json: String) throws -> String { try system(json).text.key }
        XCTAssertEqual(try key(#"{"kind":"setting_changed","by":"a","args":{"setting":"chatEnabled","value":false}}"#),
                       "party.system.setting_chatEnabled_off")
        XCTAssertEqual(try key(#"{"kind":"setting_changed","by":"a","args":{"setting":"policy","value":"host_only"}}"#),
                       "party.system.setting_policy_host_only")
        XCTAssertEqual(try key(#"{"kind":"voted","by":"a","args":{"title":"T","value":1}}"#), "party.system.voted_up")
        XCTAssertEqual(try key(#"{"kind":"voted","by":"a","args":{"title":"","value":-1}}"#), "party.system.voted_hidden")
        XCTAssertEqual(try key(#"{"kind":"proposed","by":"a","args":{"count":3}}"#), "party.system.proposed_many")
        XCTAssertEqual(try key(#"{"kind":"programme_changed","by":"a","args":{"added":2,"removed":1}}"#),
                       "party.system.programme_changed_added_removed")
        XCTAssertEqual(try key(#"{"kind":"item_skipped","by":null,"args":{"title":""}}"#), "party.system.item_skipped_hidden")
    }

    func testSystemParamsCarryTheArgs() throws {
        let params = try system(#"{"kind":"people_added","by":"a","args":{"usernames":["b","c"]}}"#).text.params
        XCTAssertEqual(params["names"], "b, c")
        XCTAssertEqual(params["by"], "a")
    }
}
