import XCTest
@testable import FliksTV

final class LossyDecodeTests: XCTestCase {
    private struct Row: Decodable { let id: Int }

    func testLossyArrayDropsOnlyTheBrokenRows() throws {
        let json = Data(#"[{"id":1},{"id":"x"},{"nope":true},{"id":4}]"#.utf8)
        let rows = try JSONDecoder().decode(LossyArray<Row>.self, from: json).elements
        XCTAssertEqual(rows.map(\.id), [1, 4])
    }

    func testPaginatedKeepsTheTotalAndTheGoodRows() throws {
        let json = Data(#"{"data":[{"id":1},{"id":null}],"total":2}"#.utf8)
        let page = try JSONDecoder().decode(Paginated<Row>.self, from: json)
        XCTAssertEqual(page.data.map(\.id), [1])
        XCTAssertEqual(page.total, 2)
    }

    func testContinueWatchingRowWithNullDurationDecodes() throws {
        let json = Data("""
        [{"mediaId":1,"mediaFileId":2,"episodeId":null,"positionSeconds":10,"durationSeconds":null,
          "progressPercent":5,"lastPlayedAt":"2026-01-02T00:00:00.000Z","mediaTitle":"T","mediaType":"movie",
          "posterUrl":null,"fanartUrl":null,"stillUrl":null,"episodeLabel":null}]
        """.utf8)
        let rows = try JSONDecoder.fliks.decode([ContinueWatchingItem].self, from: json)
        XCTAssertEqual(rows.count, 1)
        XCTAssertNil(rows[0].durationSeconds)
    }

    func testStoredProfileReadsASessionStoredWithTheWholeUser() throws {
        let legacy = Data("""
        {"serverUrl":"http://nas","user":{"id":7,"username":"ana","avatar":null,"isAdmin":true,
          "permissions":["requests.create"],"libraryOrder":[3,1],"hiddenLibraryIds":[2],"email":"a@b.c",
          "shareTastes":true},"accessToken":"a","refreshToken":"r","refreshExpiresAt":null,"lastUsedAt":1}
        """.utf8)
        let sessions = try JSONDecoder().decode(LossyArray<StoredSession>.self, from: legacy).elements
        XCTAssertEqual(sessions.count, 1)
        XCTAssertEqual(sessions[0].user.id, 7)
        XCTAssertEqual(sessions[0].user.hiddenLibraryIds, [2])
        XCTAssertEqual(User(restoring: sessions[0].user).permissions, ["requests.create"])
    }

    func testStoredProfileSurvivesAMissingOptionalField() throws {
        let json = Data(#"{"id":7,"username":"ana"}"#.utf8)
        let profile = try JSONDecoder().decode(StoredProfile.self, from: json)
        XCTAssertEqual(profile.permissions, [])
        XCTAssertFalse(profile.isAdmin)
    }
}
