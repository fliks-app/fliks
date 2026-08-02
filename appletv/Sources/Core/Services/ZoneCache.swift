import Foundation

/// Last successful payload of each home zone, on disk. A cold start paints the
/// previous content instead of skeletons, and a refresh that fails keeps
/// showing something rather than an error line.
///
/// Scoped per (server, user): switching account must not surface someone
/// else's rows.
enum ZoneCache {
    private static let directory: URL = {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("zones", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base
    }()

    static func read<T: Decodable>(_ key: String) -> [T]? {
        guard let data = try? Data(contentsOf: url(for: key)) else { return nil }
        return try? JSONDecoder.fliks.decode([T].self, from: data)
    }

    static func write<T: Encodable>(_ key: String, _ value: [T]) {
        guard let data = try? JSONEncoder.fliks.encode(value) else { return }
        try? data.write(to: url(for: key), options: .atomic)
    }

    private static func url(for key: String) -> URL {
        let scope = "\(ServerStore.shared.url)|\(AuthService.shared.currentUser?.id ?? 0)|\(key)"
        return directory.appendingPathComponent("\(fingerprint(scope)).json")
    }

    /// FNV-1a — `hashValue` is seeded per process, so it can't name a file
    /// that has to be found again on the next launch.
    private static func fingerprint(_ value: String) -> String {
        var hash: UInt64 = 14695981039346656037
        for byte in value.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 1099511628211
        }
        return String(hash, radix: 16)
    }
}

/// Paints the cached payload, then refreshes from the server. The zone only
/// reports an error when it has nothing to show.
@MainActor
func revalidateZone<T: Codable>(
    _ key: String,
    apply: (ZoneState<T>) -> Void,
    fetch: () async throws -> [T]
) async {
    var painted = false
    if let cached: [T] = ZoneCache.read(key) {
        apply(.loaded(cached))
        painted = true
    } else {
        apply(.loading)
    }
    do {
        let items = try await fetch()
        apply(.loaded(items))
        ZoneCache.write(key, items)
    } catch {
        if !painted { apply(.failed) }
    }
}
