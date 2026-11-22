import XCTest
@testable import FliksTV

final class PlaybackStartTests: XCTestCase {
    func testNoIntentFollowsTheServer() {
        XCTAssertEqual(resolveStart(nil, server: 1234), 1234)
        XCTAssertEqual(resolveStart(nil, server: nil), 0)
    }

    func testExplicitZeroOverridesTheServer() {
        XCTAssertEqual(resolveStart(0, server: 1234), 0)
    }

    func testExplicitPositionOverridesTheServer() {
        XCTAssertEqual(resolveStart(90, server: 1234), 90)
        XCTAssertEqual(resolveStart(90, server: nil), 90)
    }
}
