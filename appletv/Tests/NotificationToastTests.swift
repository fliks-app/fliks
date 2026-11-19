import XCTest
@testable import FliksTV

final class NotificationToastTests: XCTestCase {
    func testDecodesOnlyNotificationEvents() {
        let wire = #"{"type":"notification","id":"a","ts":1,"ttl":60,"cat":"account","title":"T","body":"B","url":"/","image":"/api/images/x","badge":0,"tag":"episodes:3"}"#
        let note = NotificationToastService.decode(Data(wire.utf8))
        XCTAssertEqual(note?.title, "T")
        XCTAssertEqual(note?.tag, "episodes:3")
        XCTAssertNil(NotificationToastService.decode(Data(#"{"type":"sse.connected"}"#.utf8)))
    }
}
