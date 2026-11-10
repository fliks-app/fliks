import XCTest
@testable import FliksTV

final class DeviceNameTests: XCTestCase {
    func testGenericNameBecomesModelLabel() {
        XCTAssertEqual(DeviceName.resolve(name: "Apple TV", model: "AppleTV14,1"), "Apple TV 4K (3rd generation)")
    }

    func testChosenNameAndUnknownModelAreKept() {
        XCTAssertEqual(DeviceName.resolve(name: "Living room", model: "AppleTV14,1"), "Living room")
        XCTAssertEqual(DeviceName.resolve(name: "Apple TV", model: "AppleTV99,9"), "Apple TV")
    }
}
