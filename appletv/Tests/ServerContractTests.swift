import XCTest
@testable import FliksTV

/// The server's recorded response bodies (the parity scenarios' `expect.body`) decoded into the models tvOS
/// uses, strictly: a shape change on the server turns red here, where the app would drop the row or the rail.
/// A recording drops the keys its scenario `ignore`s, so those are put back before decoding.
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

    /// Stand-ins for a trimmed key, tried in turn until the model accepts one.
    private static let standIns: [Any] = ["2000-01-01T00:00:00.000Z", 0, false, [Any]()]

    /// The last key of each `ignore` path (`$..updatedAt`, `$.files[*].id`).
    private static func trimmedKeys(_ scenario: [String: Any], _ step: [String: Any]) -> Set<String> {
        let paths = (scenario["ignore"] as? [String] ?? []) + (step["ignore"] as? [String] ?? [])
        return Set(paths.compactMap { $0.split(separator: ".").last.map(String.init) })
    }

    private static func set(_ node: Any, _ path: ArraySlice<CodingKey>, to value: Any) -> Any {
        guard let head = path.first else { return value }
        if let index = head.intValue, var array = node as? [Any], array.indices.contains(index) {
            array[index] = set(array[index], path.dropFirst(), to: value)
            return array
        }
        if var object = node as? [String: Any] {
            object[head.stringValue] = set(object[head.stringValue] ?? NSNull(), path.dropFirst(), to: value)
            return object
        }
        return node
    }

    /// Decodes `body`; a trimmed key the model requires gets a stand-in of the type it asks for. A key the
    /// scenario did not trim, or a trimmed one of a type no stand-in fits, still fails.
    private static func decode(_ body: Any, trimmed: Set<String>, with decode: (Data) throws -> Void) throws {
        var body = body
        var tried: [String: Int] = [:]
        while true {
            do {
                return try decode(JSONSerialization.data(withJSONObject: body))
            } catch let DecodingError.keyNotFound(key, context) where trimmed.contains(key.stringValue) {
                let path = context.codingPath + [key]
                tried[path.map(\.stringValue).joined(separator: "/")] = 0
                body = set(body, path[...], to: standIns[0])
            } catch let DecodingError.typeMismatch(_, context) where tried[context.codingPath.map(\.stringValue).joined(separator: "/")] != nil {
                let id = context.codingPath.map(\.stringValue).joined(separator: "/")
                let next = tried[id]! + 1
                guard next < standIns.count else { throw DecodingError.typeMismatch(Any.self, context) }
                tried[id] = next
                body = set(body, context.codingPath[...], to: standIns[next])
            }
        }
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
                    try Self.decode(body, trimmed: Self.trimmedKeys(scenario, step), with: decode)
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
