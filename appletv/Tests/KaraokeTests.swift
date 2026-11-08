import XCTest
@testable import FliksTV

final class KaraokeTests: XCTestCase {
    private func doc(_ cueLines: [(agent: String?, cues: [(Int, Int, Double, Bool)])], agents: [String] = []) throws -> StructuredLyrics {
        let lines = cueLines.enumerated().map { i, l in
            let cues = l.cues.map { #"{"start":\#($0.0),"end":\#($0.1),"value":"x","pitch":\#($0.2),"golden":\#($0.3)}"# }.joined(separator: ",")
            let agent = l.agent.map { #""agentId":"\#($0)","# } ?? ""
            return #"{"index":\#(i),\#(agent)"start":\#(l.cues[0].0),"end":\#(l.cues.last!.1),"value":"x","cue":[\#(cues)]}"#
        }.joined(separator: ",")
        let ag = agents.enumerated().map { #"{"id":"\#($1)","role":"\#($0 == 2 ? "bg" : "voice")"}"# }.joined(separator: ",")
        let json = #"{"id":1,"kind":"main","lang":"en","synced":true,"offset":0,"line":[],"agents":[\#(ag)],"cueLine":[\#(lines)]}"#
        return try JSONDecoder().decode(StructuredLyrics.self, from: Data(json.utf8))
    }

    private func sing(_ from: Double, _ to: Double, _ midi: Double?) -> [PitchFrame] {
        stride(from: from, to: to, by: 20).map { PitchFrame(t: $0, midi: midi) }
    }

    func testFoldsOctaves() {
        XCTAssertEqual(foldedDistance(48, 60), 0)
        XCTAssertEqual(foldedDistance(60, 66.5), 5.5, accuracy: 0.001)
    }

    func testPerfectTakeIsFullEvenAnOctaveAwayAndSilenceIsZero() throws {
        let d = try doc([(nil, [(0, 1000, 60, false), (1000, 2000, 64, false)])])
        let lines = d.scoredLines(agentId: nil)
        XCTAssertEqual(scoreSinger(lines, frames: sing(0, 1000, 48) + sing(1000, 2000, 76), difficulty: .hard).score, 10000)
        XCTAssertEqual(scoreSinger(lines, frames: sing(0, 2000, nil), difficulty: .hard).score, 0)
    }

    func testDifficultyWindowGoldenAndLatency() throws {
        let one = try doc([(nil, [(0, 1000, 60, false)])]).scoredLines(agentId: nil)
        let off = sing(0, 1000, 61.2)
        XCTAssertGreaterThan(scoreSinger(one, frames: off, difficulty: .easy).score, 0)
        XCTAssertEqual(scoreSinger(one, frames: off, difficulty: .hard).score, 0)
        XCTAssertEqual(scoreSinger(one, frames: sing(150, 1150, 60), difficulty: .medium, latencyMs: 150).score, 10000)
        let two = try doc([(nil, [(0, 1000, 60, true), (1000, 2000, 62, false)])]).scoredLines(agentId: nil)
        XCTAssertGreaterThan(scoreSinger(two, frames: sing(0, 1000, 60), difficulty: .medium).score,
                             scoreSinger(two, frames: sing(1000, 2000, 62), difficulty: .medium).score)
        XCTAssertGreaterThan(scoreSinger(two, frames: sing(0, 1000, 60) + sing(1000, 2000, 62), difficulty: .medium).lineBonus, 0)
    }

    func testPitchBatchDecodeDropsTheMalformed() {
        let frames = decodePitchBatch(#"{"k":"pf","t":[0,20,40],"m":[600,-1,605]}"#)
        XCTAssertEqual(frames, [PitchFrame(t: 0, midi: 60), PitchFrame(t: 20, midi: nil), PitchFrame(t: 40, midi: 60.5)])
        XCTAssertTrue(decodePitchBatch(#"{"k":"pf","t":[0],"m":[1,2]}"#).isEmpty)
        XCTAssertTrue(decodePitchBatch(#"{"k":"x","t":[],"m":[]}"#).isEmpty)
        XCTAssertTrue(decodePitchBatch("nope").isEmpty)
        XCTAssertEqual(decodePitchBatch(#"{"k":"pf","t":[-5,10],"m":[600,600]}"#).count, 1)
    }

    func testDuetScoresEachSingerAgainstTheirSide() throws {
        let d = try doc([("a", [(0, 1000, 60, false)]), ("b", [(1000, 2000, 67, false)])], agents: ["a", "b"])
        var store = FrameStore()
        store.add(1, sing(0, 1000, 60) + sing(1000, 2000, nil))
        store.add(2, sing(0, 1000, nil) + sing(1000, 2000, 67))
        let r = scoreAll(d, store: store, difficulty: .medium, latencyMs: 0)
        XCTAssertEqual(r.map(\.agentId), ["a", "b"])
        XCTAssertEqual(r.map(\.score.score), [10000, 10000])
    }

    func testRoundRobinOrder() {
        let q = [QueueEntry(id: 1, singerId: 1), QueueEntry(id: 2, singerId: 1), QueueEntry(id: 3, singerId: 2), QueueEntry(id: 4, singerId: 2)]
        XCTAssertEqual(orderQueue(q).map(\.id), [1, 3, 2, 4])
        XCTAssertEqual(orderQueue(q, lastSung: [1: 10, 2: 5]).map(\.id), [3, 1, 4, 2])
    }

    func testLaneNotesFoldThePitchIntoOneOctave() throws {
        let d = try doc([(nil, [(0, 1000, 62, false), (5000, 6000, 70, true)])])
        let notes = d.laneNotes(from: 0, to: 2000)
        XCTAssertEqual(notes.count, 1)
        XCTAssertEqual(notes[0].fold, 2, accuracy: 0.001)
    }
}
