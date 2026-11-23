import XCTest
@testable import FliksTV

@MainActor
final class RemoteAckTests: XCTestCase {
    private func command(_ id: String, action: String) throws -> RemoteCommand {
        try JSONDecoder().decode(RemoteCommand.self, from: Data(#"{"cmdId":"\#(id)","expiresAt":1,"action":"\#(action)"}"#.utf8))
    }

    override func setUp() { RemoteControlService.shared.reset() }
    override func tearDown() { RemoteControlService.shared.reset() }

    func testAckBodyNamesTheTargetTheCommandAndTheReason() throws {
        let enc = JSONEncoder()
        enc.outputFormatting = .sortedKeys
        let body = try enc.encode(RemoteAck(targetId: "t1", cmdId: "c1", refused: "no_player"))
        XCTAssertEqual(String(decoding: body, as: UTF8.self), #"{"cmdId":"c1","refused":"no_player","targetId":"t1"}"#)
    }

    func testASettledCommandCarriesNoReasonAndARefusalReplacesIt() {
        let remote = RemoteControlService.shared
        remote.settle("c1", refused: "no_next")
        XCTAssertEqual([remote.lastAppliedCmdId, remote.lastCmdRefused], ["c1", "no_next"])
        remote.settle("c2")
        XCTAssertEqual(remote.lastAppliedCmdId, "c2")
        XCTAssertNil(remote.lastCmdRefused)
    }

    func testARefusalWithoutAPlayerIsSettledEvenBeforeTheTargetRegistered() throws {
        let remote = RemoteControlService.shared
        remote.refuse(try command("c3", action: "seek"), "no_player")
        XCTAssertEqual([remote.lastAppliedCmdId, remote.lastCmdRefused], ["c3", "no_player"])
    }

    func testResetForgetsTheAnswerOfTheAccountThatLeft() {
        let remote = RemoteControlService.shared
        remote.settle("c4", refused: "no_quality")
        remote.reset()
        XCTAssertNil(remote.lastAppliedCmdId)
        XCTAssertNil(remote.lastCmdRefused)
    }
}
