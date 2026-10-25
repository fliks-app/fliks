import XCTest
@testable import FliksTV

final class SSEParserTests: XCTestCase {
    private func parse(_ text: String, split: Int = .max) -> [SSEMessage] {
        var parser = SSEParser()
        let bytes = Array(text.utf8)
        var out: [SSEMessage] = []
        var i = 0
        while i < bytes.count {
            out += parser.feed(Data(bytes[i..<min(i + split, bytes.count)]))
            i += split
        }
        return out
    }

    func testServerFramesWithTheLeadingBlankLine() {
        let wire = "\nid: 1\ndata: {\"type\":\"sse.connected\"}\n\nid: 2\ndata: {\"type\":\"party.members\"}\n\n"
        XCTAssertEqual(parse(wire), [
            SSEMessage(event: nil, data: "{\"type\":\"sse.connected\"}"),
            SSEMessage(event: nil, data: "{\"type\":\"party.members\"}"),
        ])
    }

    func testNamedPingEvent() {
        XCTAssertEqual(parse("event: ping\nid: 3\ndata: 30000\n\n"), [SSEMessage(event: "ping", data: "30000")])
    }

    func testMessageSplitAcrossChunksOneByteAtATime() {
        XCTAssertEqual(parse("id: 4\ndata: {\"a\":1}\n\n", split: 1), [SSEMessage(event: nil, data: "{\"a\":1}")])
    }

    func testMultipleDataLinesJoinWithANewline() {
        XCTAssertEqual(parse("data: one\ndata: two\n\n"), [SSEMessage(event: nil, data: "one\ntwo")])
    }

    func testCRLFAndCommentsAreHandled() {
        XCTAssertEqual(parse(": keepalive\r\ndata: x\r\n\r\n"), [SSEMessage(event: nil, data: "x")])
    }

    func testAnEventNameDoesNotLeakIntoTheNextMessage() {
        let out = parse("event: ping\ndata: 1\n\ndata: 2\n\n")
        XCTAssertEqual(out.map(\.event), ["ping", nil])
    }

    func testAnUnterminatedMessageIsNotDelivered() {
        XCTAssertTrue(parse("data: half\n").isEmpty)
    }
}
