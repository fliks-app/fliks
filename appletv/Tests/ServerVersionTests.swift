import XCTest
@testable import FliksTV

final class ServerVersionTests: XCTestCase {
    func testNumericCompareIgnoresSuffixAndPrefix() {
        XCTAssertTrue(ServerVersion.isNewer("5.2.0", than: "5.1.9"))
        XCTAssertFalse(ServerVersion.isNewer("5.2.0", than: "v5.2.0-beta.1"))
        XCTAssertFalse(ServerVersion.isNewer("5.2.0", than: "5.10.0"))
        XCTAssertFalse(ServerVersion.isNewer("5.2.0", than: "garbage"))
    }
}
