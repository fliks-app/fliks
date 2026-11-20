import Foundation

/// The signed-in sessions the web layer keeps in `Preferences` (`UserDefaults`), read and rotated natively.
enum StoredSessions {
    private static let sessionsKey = "CapacitorStorage.fliks_sessions"
    private static var rotations: [String: Task<Bool?, Never>] = [:]

    /// The one place a server URL is normalised (case of scheme and host, trailing slash).
    static func normalise(_ server: String) -> String {
        var s = server.trimmingCharacters(in: .whitespaces)
        while s.hasSuffix("/") { s.removeLast() }
        guard var parts = URLComponents(string: s) else { return s }
        parts.scheme = parts.scheme?.lowercased()
        parts.host = parts.host?.lowercased()
        return parts.string ?? s
    }

    static func key(_ server: String, _ user: Int) -> String { "\(normalise(server))::\(user)" }

    static var activeKey: String? { UserDefaults.standard.string(forKey: "CapacitorStorage.fliks_active_session") }

    static func isActive(_ server: String, _ user: Int) -> Bool {
        activeKey.map(normalisedKey) == key(server, user)
    }

    static func find(_ key: String) -> (server: String, token: String)? {
        let wanted = normalisedKey(key)
        guard let found = list().first(where: { rowKey($0) == wanted }),
              let token = found["accessToken"] as? String, !token.isEmpty else { return nil }
        return (found["serverUrl"] as? String ?? "", token)
    }

    /// Rotates the stored pair of session `key` once its access token `rejected` was refused, as the web layer would:
    /// the new pair is stored with `tokenVersion` bumped so a loaded web layer adopts it.
    /// True when a usable token is stored, false when the server refused the refresh token, nil when it was unreachable.
    @MainActor
    static func refresh(_ key: String, rejected: String) async -> Bool? {
        let wanted = normalisedKey(key)
        if let running = rotations[wanted] { return await running.value }
        let task = Task { await rotate(wanted, rejected: rejected) }
        rotations[wanted] = task
        defer { rotations[wanted] = nil }
        return await task.value
    }

    private static func rotate(_ key: String, rejected: String) async -> Bool? {
        guard let current = list().first(where: { rowKey($0) == key }) else { return false }
        if current["accessToken"] as? String != rejected { return true }
        guard let refresh = current["refreshToken"] as? String, !refresh.isEmpty,
              let url = URL(string: (current["serverUrl"] as? String ?? "") + "/api/auth/refresh") else { return false }
        var request = URLRequest(url: url, timeoutInterval: 20)
        request.httpMethod = "POST"
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["refreshToken": refresh])
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let status = (response as? HTTPURLResponse)?.statusCode else { return nil }
        if (400..<500).contains(status) { return false }
        guard (200..<300).contains(status), let pair = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let access = pair["accessToken"] as? String, let next = pair["refreshToken"] as? String else { return nil }
        // Re-read: the list may have changed while the request was in flight.
        var all = list()
        guard let i = all.firstIndex(where: { rowKey($0) == key }) else { return false }
        let expires = (pair["refreshTokenExpiresAt"] as? NSNumber)?.int64Value ?? 0
        all[i]["accessToken"] = access
        all[i]["refreshToken"] = next
        all[i]["refreshExpiresAt"] = expires > 0 ? expires * 1000 : NSNull()
        all[i]["tokenVersion"] = ((all[i]["tokenVersion"] as? NSNumber)?.intValue ?? 0) + 1
        guard let out = try? JSONSerialization.data(withJSONObject: all) else { return nil }
        UserDefaults.standard.set(String(decoding: out, as: UTF8.self), forKey: sessionsKey)
        return true
    }

    private static func list() -> [[String: Any]] {
        guard let raw = UserDefaults.standard.string(forKey: sessionsKey) else { return [] }
        return (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [[String: Any]] ?? []
    }

    private static func rowKey(_ row: [String: Any]) -> String {
        key(row["serverUrl"] as? String ?? "", ((row["user"] as? [String: Any])?["id"] as? NSNumber)?.intValue ?? 0)
    }

    private static func normalisedKey(_ raw: String) -> String {
        guard let split = raw.range(of: "::", options: .backwards) else { return raw }
        return key(String(raw[..<split.lowerBound]), Int(raw[split.upperBound...]) ?? 0)
    }
}
