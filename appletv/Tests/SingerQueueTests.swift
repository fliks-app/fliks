import XCTest
@testable import FliksTV

final class SingerQueueTests: XCTestCase {
    private func proposal(_ id: Int, by: Int, position: Int?, track: Bool = true) -> String {
        let item = #"{"mediaId":9,"mediaFileId":null,"episodeId":null,"title":"S\#(id)","posterUrl":null,"fanartUrl":null,"hidden":false\#(track ? #","itemId":\#(id)"# : "")}"#
        let pos = position.map { #","queuePosition":\#($0)"# } ?? ""
        return #"{"id":\#(id),"item":\#(item),"proposedBy":\#(by),"upvoterIds":[],"downvoterIds":[]\#(pos)}"#
    }

    private func decode(_ parts: [String]) throws -> [PartyProposal] {
        try JSONDecoder().decode([PartyProposal].self, from: Data("[\(parts.joined(separator: ","))]".utf8))
    }

    func testDecodesTheQueuePositionAndItsAbsenceOnAFilm() throws {
        let list = try decode([proposal(1, by: 5, position: 2), proposal(2, by: 6, position: nil, track: false)])
        XCTAssertEqual(list.map(\.queuePosition), [2, nil])
    }

    func testLinesFollowTheServerOrderAndSkipFilms() throws {
        let list = try decode([proposal(1, by: 5, position: 3), proposal(2, by: 6, position: 1), proposal(3, by: 7, position: nil, track: false), proposal(4, by: 5, position: 2)])
        let lines = singerQueueLines(list, names: [5: "ann", 6: "bob"], me: 5, isHost: false)
        XCTAssertEqual(lines.map(\.id), [2, 4, 1])
        XCTAssertEqual(lines.map(\.singer), ["bob", "ann", "ann"])
        XCTAssertEqual(lines.map(\.canRemove), [false, true, true])
        XCTAssertFalse(lines.contains { $0.canPlay })
    }

    func testTheHostPlaysAndRemovesAny() throws {
        let lines = singerQueueLines(try decode([proposal(1, by: 5, position: 1)]), names: [:], me: 9, isHost: true)
        XCTAssertEqual(lines.map { [$0.canPlay, $0.canRemove] }, [[true, true]])
    }
}
