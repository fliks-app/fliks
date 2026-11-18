import XCTest
@testable import FliksTV

final class MusicTests: XCTestCase {
    private func track(_ id: Int, album: Int = 1, gain: Double? = nil, peak: Double? = nil, albumGain: Double? = nil) -> QueueTrack {
        QueueTrack(itemId: id, mediaId: album, title: "t\(id)", artists: "a", albumTitle: "al", coverUrl: nil,
                   durationSeconds: 100, gain: gain, peak: peak, albumGain: albumGain, albumPeak: nil)
    }

    func testStreamPathFollowsTheDecision() {
        let hls = "/api/stream/s/item/index.m3u8"
        let part = "/api/stream/s/parts/0"
        XCTAssertEqual(MusicPlayer.streamPath(playMethod: "DirectPlay", pitched: false, partUrl: part, playUrl: hls), part)
        XCTAssertEqual(MusicPlayer.streamPath(playMethod: "Transcode", pitched: false, partUrl: part, playUrl: hls), hls)
        XCTAssertEqual(MusicPlayer.streamPath(playMethod: "DirectStream", pitched: false, partUrl: nil, playUrl: hls), hls)
        XCTAssertEqual(MusicPlayer.streamPath(playMethod: "DirectPlay", pitched: true, partUrl: part, playUrl: hls), hls)
    }

    func testAudioFileFormatsFollowThePlayableTypes() {
        let formats = DeviceProfileBuilder.audioFileFormats { $0 == "audio/mpeg" || $0.hasPrefix("audio/mp4") && $0.contains("alac") }
        XCTAssertEqual(formats.containers, ["mp3", "mp4"])
        XCTAssertEqual(formats.codecs, ["mp3", "alac"])
    }

    func testVideoContainersFollowTheAudiovisualTypes() {
        XCTAssertEqual(DeviceProfileBuilder.videoContainers(types: ["video/mp4", "video/x-m4v", "audio/mpeg"]), ["mp4", "m4v"])
        XCTAssertEqual(DeviceProfileBuilder.videoContainers(types: []), [])
    }

    func testTheProfileCarriesTheAudioFilesEntryOnEveryRequest() {
        XCTAssertEqual(DeviceProfileBuilder.build().directPlayProfiles.count, 2)
        XCTAssertEqual(DeviceProfileBuilder.build().directPlayProfiles.last?.videoCodecs, [])
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

    func testAdoptKeepsTheOwnersOrderAndOnlyFlagsShuffle() {
        var q = MusicQueue()
        q.adopt([5, 2, 9].map { track($0) }, start: 1, shuffled: true)
        XCTAssertEqual(q.tracks.map(\.itemId), [5, 2, 9])
        XCTAssertEqual(q.current?.itemId, 2)
        XCTAssertTrue(q.shuffled)
    }

    func testEnqueueCommandDecodesItsTracksAndPlace() throws {
        let json = #"{"cmdId":"c","expiresAt":1,"action":"enqueue","itemIds":[4,7],"where":"next"}"#
        let cmd = try JSONDecoder().decode(RemoteCommand.self, from: Data(json.utf8))
        XCTAssertEqual(cmd.itemIds, [4, 7])
        XCTAssertEqual(cmd.enqueueAt, "next")
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
        let json = #"{"mediaId":5,"mediaFileId":null,"episodeId":null,"title":"Song","posterUrl":null,"fanartUrl":null,"hidden":false,"itemId":77,"mediaType":"album","seriesTitle":"Album","addedBy":4}"#
        let item = try JSONDecoder().decode(PartyItem.self, from: Data(json.utf8))
        XCTAssertTrue(item.isTrack)
        XCTAssertEqual(item.addedBy, 4)
        XCTAssertEqual(item.cardTitle, "Song")
        XCTAssertEqual(item.cardSubtitle, "Album")
        var other = item
        other.itemId = 78
        XCTAssertFalse(item.sameEntry(as: other))
    }

    func testAFilmRowIsNotATrackEvenWithItsItemId() throws {
        let json = #"{"mediaId":5,"mediaFileId":null,"episodeId":null,"title":"Film","posterUrl":null,"fanartUrl":null,"hidden":false,"itemId":9,"mediaType":"movie","addedBy":null}"#
        let item = try JSONDecoder().decode(PartyItem.self, from: Data(json.utf8))
        XCTAssertFalse(item.isTrack)
        XCTAssertNil(item.addedBy)
    }

    func testUpNextIsTheThreeRowsAfterThePlayingOne() {
        func row(_ n: Int) -> PartyItem {
            PartyItem(mediaId: 9, mediaFileId: nil, episodeId: nil, title: "S\(n)", posterUrl: nil, fanartUrl: nil, hidden: false, itemId: n)
        }
        let rows = (1...6).map(row)
        XCTAssertEqual(PartyItem.upNext(after: rows[1], in: rows).compactMap(\.itemId), [3, 4, 5])
        XCTAssertEqual(PartyItem.upNext(after: rows[5], in: rows), [])
        XCTAssertEqual(PartyItem.upNext(after: nil, in: rows).compactMap(\.itemId), [1, 2, 3])
    }

    func testAlbumPageDecodesItsRelease() throws {
        let json = #"""
        {"id":370,"title":"Bad","year":null,"overview":null,"posterUrl":null,"fanartUrl":null,"genres":[],
         "album":{"primaryType":"Album","secondaryTypes":[],"firstReleaseDate":"1987-01-01","isCompilation":false,
          "orphaned":false,"artists":[{"id":1,"name":"A","creditedName":null,"joinPhrase":null}],
          "release":{"albumGain":-3.5,"albumPeak":0.9,"barcode":null,"catalogNumber":"X 1","country":"JP",
           "coverUrl":null,"disambiguation":null,"discCount":1,"label":"Epic","media":"cd","releaseDate":null,
           "status":"official","title":null,"trackCount":1},
          "versions":[],"sharedTracks":0,"releaseGroupId":"g",
          "tracks":[{"itemId":9,"mediaFileId":4,"hasFile":true,"orphaned":false,"discNumber":1,"discTitle":null,
           "position":1,"trackNumber":1,"label":null,"title":"T","durationSeconds":10,"explicit":false,"gain":null,
           "peak":null,"artists":[],"credits":[],"favourite":false,"playCount":0,"lastPlayedAt":null}]}}
        """#
        let page = try JSONDecoder().decode(AlbumPage.self, from: Data(json.utf8))
        XCTAssertEqual(page.album.release.label, "Epic")
        XCTAssertEqual(page.queue.map(\.itemId), [9])
        XCTAssertEqual(page.queue.first?.albumGain, -3.5)
    }

    func testDurationFormat() {
        XCTAssertEqual(MusicFormat.duration(185), "3:05")
        XCTAssertEqual(MusicFormat.duration(3725), "1:02:05")
    }
}
