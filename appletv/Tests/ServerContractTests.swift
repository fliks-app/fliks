import XCTest
@testable import FliksTV

/// The server's recorded response bodies (the parity scenarios' `expect.body`) decoded into the models tvOS
/// uses, strictly: a shape change on the server turns red here, where the app would drop the row or the rail.
final class ServerContractTests: XCTestCase {
    private static let scenarios = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("server/parity/scenarios")

    private static func strict<T: Decodable>(_ type: T.Type) -> (Data) throws -> Void {
        { _ = try JSONDecoder.fliks.decode(T.self, from: $0) }
    }

    /// Route with its numeric ids as `:id`, to the model of its body.
    private static let routes: [String: (Data) throws -> Void] = [
        "/api/auth/me": strict(User.self),
        "/api/libraries/mine": strict([Library].self),
        "/api/likes": strict([LikedItem].self),
        "/api/media": strict(StrictPage<Media>.self),
        "/api/media/:id": strict(Media.self),
        "/api/media/:id/cast": strict([MediaCastEntry].self),
        "/api/media/calendar": strict([CalendarEntry].self),
        "/api/media/recently-added": strict([Media].self),
        "/api/playback/continue-watching": strict([ContinueWatchingItem].self),
        "/api/playback/recommendations": strict([RecommendationItem].self),
        "/api/playlists": strict([Playlist].self),
        "/api/requests": strict(StrictPage<RequestSummary>.self),
    ]

    /// `Paginated` drops a row that fails; the contract test wants the failure.
    private struct StrictPage<T: Decodable>: Decodable {
        let data: [T]
        let total: Int
    }

    func testRecordedServerBodiesDecode() throws {
        let files = try XCTUnwrap(FileManager.default.enumerator(at: Self.scenarios, includingPropertiesForKeys: nil))
        var decoded = 0
        var failures: [String] = []
        for case let file as URL in files where file.pathExtension == "json" {
            // Books and comics have no tvOS player: their rows are filtered out of every list.
            if file.pathComponents.contains("books") { continue }
            guard let scenario = try? JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any],
                  let steps = scenario["steps"] as? [[String: Any]] else { continue }
            for step in steps where step["method"] as? String == "GET" {
                guard let path = step["path"] as? String, !path.contains("type=book"), !path.contains("type=comic"),
                      let expect = step["expect"] as? [String: Any], expect["status"] as? Int == 200,
                      let body = expect["body"], JSONSerialization.isValidJSONObject(body) else { continue }
                let route = path.split(separator: "?", maxSplits: 1).first.map(String.init) ?? path
                let key = route.replacingOccurrences(of: #"/\d+"#, with: "/:id", options: .regularExpression)
                guard let decode = Self.routes[key] else { continue }
                do {
                    try decode(JSONSerialization.data(withJSONObject: body))
                    decoded += 1
                } catch {
                    failures.append("\(file.deletingPathExtension().lastPathComponent) \(path): \(error)")
                }
            }
        }
        XCTAssertGreaterThan(decoded, 20, "the scenarios moved: the test decoded almost nothing")
        XCTAssert(failures.isEmpty, "\(failures.count) recorded bodies do not decode:\n" + failures.sorted().joined(separator: "\n"))
    }
}
