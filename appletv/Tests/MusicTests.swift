import XCTest
@testable import FliksTV

final class MusicTests: XCTestCase {
    private func track(_ id: Int, album: Int = 1, gain: Double? = nil, peak: Double? = nil, albumGain: Double? = nil) -> QueueTrack {
        QueueTrack(itemId: id, mediaId: album, title: "t\(id)", artists: "a", albumTitle: "al", coverUrl: nil,
                   durationSeconds: 100, gain: gain, peak: peak, albumGain: albumGain, albumPeak: nil)
    }

    func testShuffleKeepsCurrentFirstAndRestoresOrder() {
        var q = MusicQueue()
        q.set((1...6).map { track($0) }, start: 2)
        q.setShuffle(true)
        XCTAssertEqual(q.current?.itemId, 3)
        XCTAssertEqual(q.index, 0)
        XCTAssertEqual(Set(q.tracks.map(\.itemId)), Set(1...6))
        q.setShuffle(false)
        XCTAssertEqual(q.tracks.map(\.itemId), Array(1...6))
        XCTAssertEqual(q.current?.itemId, 3)
    }

    func testRepeatAllWrapsAndOffStops() {
        var q = MusicQueue()
        q.set([track(1), track(2)], start: 1)
        XCTAssertNil(q.next(auto: true))
        q.repeatMode = .all
        XCTAssertEqual(q.next(auto: true)?.itemId, 1)
        q.repeatMode = .one
        XCTAssertEqual(q.next(auto: true)?.itemId, 1)
        XCTAssertEqual(q.next(auto: false)?.itemId, 2)
    }

    func testRemoveCurrentLeavesTheFollowingTrack() {
        var q = MusicQueue()
        q.set([track(1), track(2), track(3)], start: 1)
        q.remove(at: 1)
        XCTAssertEqual(q.current?.itemId, 3)
        q.addNext([track(9)])
        XCTAssertEqual(q.tracks.map(\.itemId), [1, 3, 9])
    }

    func testReplayGainOnlyAttenuatesAndHonoursPeak() {
        XCTAssertEqual(ReplayGain.volume(.off, track(1, gain: -6), oneAlbum: true), 1)
        XCTAssertEqual(ReplayGain.volume(.track, track(1, gain: -6), oneAlbum: true), pow(10, -0.3), accuracy: 0.001)
        XCTAssertEqual(ReplayGain.volume(.track, track(1, gain: 6), oneAlbum: true), 1)
        XCTAssertEqual(ReplayGain.volume(.album, track(1, gain: -6, albumGain: -3), oneAlbum: true), pow(10, -0.15), accuracy: 0.001)
        XCTAssertEqual(ReplayGain.volume(.album, track(1, gain: -6, albumGain: -3), oneAlbum: false), pow(10, -0.3), accuracy: 0.001)
    }

    func testLyricsActiveLineUsesTheOffset() throws {
        let json = #"{"id":1,"kind":"main","lang":"en","synced":true,"offset":500,"line":[{"start":1000,"value":"a"},{"start":3000,"value":"b"}]}"#
        let l = try JSONDecoder().decode(StructuredLyrics.self, from: Data(json.utf8))
        XCTAssertNil(l.activeLine(atMs: 400))
        XCTAssertEqual(l.activeLine(atMs: 600), 0)
        XCTAssertEqual(l.activeLine(atMs: 2600), 1)
    }

    func testPartyItemNamesATrackByItsItem() throws {
        let json = #"{"mediaId":5,"mediaFileId":null,"episodeId":null,"title":"Song","posterUrl":null,"fanartUrl":null,"hidden":false,"itemId":77,"seriesTitle":"Album"}"#
        let item = try JSONDecoder().decode(PartyItem.self, from: Data(json.utf8))
        XCTAssertTrue(item.isTrack)
        XCTAssertEqual(item.cardTitle, "Song")
        XCTAssertEqual(item.cardSubtitle, "Album")
        var other = item
        other.itemId = 78
        XCTAssertFalse(item.sameEntry(as: other))
    }

    func testDurationFormat() {
        XCTAssertEqual(MusicFormat.duration(185), "3:05")
        XCTAssertEqual(MusicFormat.duration(3725), "1:02:05")
    }
}
