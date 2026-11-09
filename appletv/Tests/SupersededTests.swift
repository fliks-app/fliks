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
        guard case .superseded(let sid, let device) = entries[1] else { return XCTFail("superseded") }
        XCTAssertEqual(sid, "s1")
        XCTAssertEqual(device, "Phone")
        guard case .other = entries[2] else { return XCTFail("other") }
    }

    func testGateActsOnceAndOnlyOnTheCurrentSession() {
        var gate = SupersededGate()
        XCTAssertFalse(gate.accept("old", current: "s1"))
        XCTAssertTrue(gate.accept("s1", current: "s1"))
        XCTAssertFalse(gate.accept("s1", current: "s1"))
        XCTAssertFalse(gate.accept("s1", current: nil))
    }
}
