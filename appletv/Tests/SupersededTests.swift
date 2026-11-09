import XCTest
@testable import FliksTV

final class SupersededTests: XCTestCase {
    private func decode(_ json: String) throws -> [RemoteQueueEntry] {
        try JSONDecoder().decode([RemoteQueueEntry].self, from: Data(json.utf8))
    }

    func testQueueCarriesCommandsAndSuperseded() throws {
        let entries = try decode("""
        [{"type":"remote.command","cmdId":"c1","expiresAt":1,"action":"stop"},
         {"type":"session.superseded","sessionId":"s1","byDeviceName":"Phone","epoch":2},
         {"type":"remote.targetsChanged"}]
        """)
        guard case .command(let cmd) = entries[0], cmd.action == "stop" else { return XCTFail("command") }
        guard case .superseded(let sid, let device, let silent) = entries[1] else { return XCTFail("superseded") }
        XCTAssertEqual(sid, "s1")
        XCTAssertEqual(device, "Phone")
        XCTAssertFalse(silent)
        guard case .other = entries[2] else { return XCTFail("other") }
    }

    func testSilentFlagIsDecoded() throws {
        let entries = try decode(#"[{"type":"session.superseded","sessionId":"s1","byDeviceName":null,"epoch":2,"silent":true}]"#)
        guard case .superseded(_, _, let silent) = entries[0] else { return XCTFail("superseded") }
        XCTAssertTrue(silent)
    }

    func testGateActsOnceAndOnlyOnTheCurrentSession() {
        var gate = SupersededGate()
        XCTAssertFalse(gate.accept("old", current: "s1"))
        XCTAssertTrue(gate.accept("s1", current: "s1"))
        XCTAssertFalse(gate.accept("s1", current: "s1"))
        XCTAssertFalse(gate.accept("s1", current: nil))
    }

    func testLoadCarriesKindAndQueue() throws {
        let entries = try decode("""
        [{"type":"remote.command","cmdId":"c1","expiresAt":1,"action":"load","kind":"album","mediaId":4,
          "queue":{"itemIds":[7,8],"index":1},"shuffle":true,"repeat":"all"}]
        """)
        guard case .command(let cmd) = entries[0] else { return XCTFail("command") }
        XCTAssertEqual(cmd.kind, "album")
        XCTAssertEqual(cmd.queueItemIds, [7, 8])
        XCTAssertEqual(cmd.queueIndex, 1)
        XCTAssertEqual(cmd.repeatMode, "all")
    }
}
