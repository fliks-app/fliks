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

    func testDecodeEdgeCases() {
        XCTAssertNil(NotificationToastService.decode(Data("not json".utf8)))
        XCTAssertNil(NotificationToastService.decode(Data(#"{"type":"notification","id":"a"}"#.utf8)))
        let min = NotificationToastService.decode(Data(#"{"type":"notification","id":"a","title":"T","body":""}"#.utf8))
        XCTAssertNil(min?.image)
        XCTAssertNil(min?.tag)
    }

    @MainActor func testReplaceDismissAndDedupe() {
        let service = NotificationToastService()
        func note(_ id: String, tag: String? = nil) -> ServerNotification {
            ServerNotification(id: id, title: id, body: "", image: nil, tag: tag, ttl: nil)
        }
        service.show(note("a", tag: "t"))
        service.show(note("b", tag: "t"))
        XCTAssertEqual(service.current?.id, "b")
        service.show(note("a"))
        XCTAssertEqual(service.current?.id, "b")
        service.stop()
        XCTAssertNil(service.current)
    }
}
