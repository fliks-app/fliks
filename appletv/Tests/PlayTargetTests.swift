import XCTest
@testable import FliksTV

final class PlayTargetTests: XCTestCase {
    private func series() throws -> Media {
        func ep(_ id: Int, _ n: Int) -> String { #"{"id":\#(id),"episodeNumber":\#(n),"monitored":true,"hasFile":true}"# }
        func file(_ id: Int, _ ep: Int) -> String { #"{"id":\#(id),"quality":"1080p","relativePath":"x","size":1,"episodeId":\#(ep)}"# }
        let json = """
        {"id":1,"title":"S","type":"series","additionalFanartUrls":[],
         "seasons":[{"id":20,"seasonNumber":1,"monitored":true,"episodes":[\(ep(12, 2)),\(ep(11, 1))]},
                    {"id":10,"seasonNumber":0,"monitored":true,"episodes":[\(ep(1, 1))]}],
         "files":[\(file(101, 1)),\(file(111, 11)),\(file(112, 12))]}
        """
        return try JSONDecoder().decode(Media.self, from: Data(json.utf8))
    }

    func testSeriesSkipsSpecialsAndWatchedEpisodes() throws {
        let m = try series()
        XCTAssertEqual(PlayTarget.of(m, resume: nil, watchedEpisodes: [])?.episodeId, 11)
        let next = PlayTarget.of(m, resume: nil, watchedEpisodes: [11])
        XCTAssertEqual(next?.episodeId, 12)
        XCTAssertEqual(next?.code, "S01E02")
        XCTAssertEqual(PlayTarget.of(m, resume: nil, watchedEpisodes: [11, 12])?.episodeId, 11)
    }

    func testSeriesResumesTheEpisodeInProgress() throws {
        let resume = MediaResumeInfo(mediaFileId: 112, episodeId: 12, positionSeconds: 30, durationSeconds: 60,
                                     seasonNumber: 1, episodeNumber: 2)
        let target = PlayTarget.of(try series(), resume: resume, watchedEpisodes: [])
        XCTAssertEqual(target?.mediaFileId, 112)
        XCTAssertEqual(target?.resume, true)
    }
}
