import XCTest
@testable import FliksTV

final class MediaKindTests: XCTestCase {
    func testDecodesKnownAndUnknownKinds() throws {
        let kinds = try JSONDecoder().decode([MediaKind].self, from: Data(#"["movie","series","book","album"]"#.utf8))
        XCTAssertEqual(kinds, [.movie, .series, .book, .album])
        XCTAssertEqual(String(data: try JSONEncoder().encode(kinds), encoding: .utf8), #"["movie","series","book","album"]"#)
    }

    func testVideoAndMusicKindsArePlayable() {
        XCTAssertEqual([MediaKind.movie, .series, .book, .comic, .album, .unknown("x")].map(\.isPlayable), [true, true, false, false, true, false])
    }

    func testOnlySeriesHasChildren() {
        XCTAssertEqual([MediaKind.movie, .series, .book, .comic, .album, .unknown("x")].map(\.hasChildren), [false, true, false, false, false, false])
    }
}
