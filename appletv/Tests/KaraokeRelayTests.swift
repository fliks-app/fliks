import XCTest
@testable import FliksTV

final class KaraokeRelayTests: XCTestCase {
    func testRelayedBatchCarriesTheSingerAndDropsTheMalformed() {
        let m = decodeRelayed(#"{"k":"pf","u":7,"t":[0,20],"m":[600,-1]}"#)
        XCTAssertEqual(m?.userId, 7)
        XCTAssertEqual(m?.frames, [PitchFrame(t: 0, midi: 60), PitchFrame(t: 20, midi: nil)])
        XCTAssertNil(decodeRelayed(#"{"k":"pf","t":[0],"m":[600]}"#))
        XCTAssertNil(decodeRelayed(#"{"k":"pf","u":7,"t":[0],"m":[1,2]}"#))
        XCTAssertNil(decodeRelayed(#"{"k":"x","u":7,"t":[],"m":[]}"#))
        XCTAssertNil(decodeRelayed("nope"))
    }

    func testSocketUrlIsTheDisplayRoleWithATicket() {
        let https = KaraokeRelay.url("https://tv.example/api/parties/3/karaoke/ws", ticket: "abc")
        XCTAssertEqual(https?.absoluteString, "wss://tv.example/api/parties/3/karaoke/ws?role=display&ticket=abc")
        XCTAssertEqual(KaraokeRelay.url("http://10.0.0.2:3000/api/parties/3/karaoke/ws", ticket: "t")?.scheme, "ws")
        XCTAssertNil(KaraokeRelay.url("", ticket: "t"))
    }

    @MainActor func testSessionScoresEachRelayedSinger() throws {
        let json = #"{"id":1,"kind":"main","lang":"en","synced":true,"offset":0,"line":[],"cueLine":[{"index":0,"start":0,"end":1000,"value":"x","cue":[{"start":0,"end":1000,"value":"x","pitch":60}]}]}"#
        let doc = try JSONDecoder().decode(StructuredLyrics.self, from: Data(json.utf8))
        let session = KaraokeSession()
        session.attach(lyrics: doc)
        session.ingest(stride(from: 0.0, to: 1000, by: 20).map { PitchFrame(t: $0, midi: 60) }, singerId: 4)
        session.ingest(stride(from: 0.0, to: 1000, by: 20).map { PitchFrame(t: $0, midi: nil) }, singerId: 5)
        XCTAssertEqual(session.results.map(\.userId), [4, 5])
        XCTAssertEqual(session.results.map(\.score.score), [10000, 0])
    }

    func testCalibrationIsTheMedianOnsetDelay() throws {
        let cues = [0, 2000, 4000, 6000].map { #"{"start":\#($0),"end":\#($0 + 500),"value":"x","pitch":60}"# }.joined(separator: ",")
        let json = #"{"id":1,"kind":"main","lang":"en","synced":true,"offset":0,"line":[],"cueLine":[{"index":0,"start":0,"end":6500,"value":"x","cue":[\#(cues)]}]}"#
        let doc = try JSONDecoder().decode(StructuredLyrics.self, from: Data(json.utf8))
        let late = [0.0, 2000, 4000, 6000].flatMap { s in
            stride(from: s + 180, to: s + 480, by: 20).map { PitchFrame(t: $0, midi: 60) }
        }
        XCTAssertEqual(doc.calibrate(frames: late), 180)
        XCTAssertNil(doc.calibrate(frames: Array(late.prefix(10))))
        XCTAssertEqual(onsets([PitchFrame(t: 0, midi: 60), PitchFrame(t: 100, midi: nil), PitchFrame(t: 150, midi: 60), PitchFrame(t: 600, midi: 60)]), [0, 600])
    }

    func testCdgScreenDrawsATileInThePaletteColour() {
        var packets = Data()
        func packet(_ command: UInt8, _ body: [UInt8]) {
            packets.append(contentsOf: [9, command, 0, 0] + body + [UInt8](repeating: 0, count: 16 - body.count) + [0, 0, 0, 0])
        }
        packet(30, [0x00, 0x00, 0x3c, 0x00])
        packet(1, [0])
        packet(6, [0, 1, 0, 0] + [UInt8](repeating: 0x3f, count: 12))
        var screen = CdgScreen(packets)
        screen.seek(ms: 1000)
        let rgba = screen.rgba()
        func pixel(_ x: Int, _ y: Int) -> [UInt8] { Array(rgba[(y * CdgScreen.width + x) * 4..<(y * CdgScreen.width + x) * 4 + 4]) }
        XCTAssertEqual(pixel(0, 0), [255, 0, 0, 255])
        XCTAssertEqual(pixel(5, 11), [255, 0, 0, 255])
        XCTAssertEqual(pixel(6, 0), [0, 0, 0, 255])
        XCTAssertEqual(pixel(0, 12), [0, 0, 0, 255])
    }
}
