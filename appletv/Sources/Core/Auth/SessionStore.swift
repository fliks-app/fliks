import Foundation

/// Credentials of one account on one server, kept so the user can leave it and
/// come back without re-authenticating. `user` is the last known profile: it
/// drives the picker and the offline boot.
struct StoredSession: Codable, Identifiable, Hashable {
    var serverUrl: String
    var user: User
    var accessToken: String?
    var refreshToken: String
    /// UNIX ms, nil when the server reported no expiry.
    var refreshExpiresAt: Double?
    var lastUsedAt: Double

    var id: String { SessionStore.key(serverUrl, user.id) }
}

/// Index of the accounts this device can sign into without a password, keyed by
/// (server, user). Persistence only — rotating and validating tokens is
/// `AuthService`'s job.
@Observable final class SessionStore {
    static let shared = SessionStore()

    /// Each session is a long-lived credential on a possibly shared device.
    static let maxSessions = 6

    private static let sessionsKey = "fliks_sessions"
    private static let activeKeyDefault = "fliks_active_session"
    private static let legacyKeys = ["fliks_access_token", "fliks_refresh_token"]

    private(set) var sessions: [StoredSession] = []
    private(set) var activeKey: String?

    var active: StoredSession? { sessions.first { $0.id == activeKey } }

    static func key(_ serverUrl: String, _ userId: Int) -> String { "\(serverUrl)::\(userId)" }

    static func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

    private init() {
        // Pre-#814 single-session secrets: not migrated, so don't leave them behind.
        for key in Self.legacyKeys { Keychain.delete(for: key) }

        let stored = Self.decode(Keychain.get(for: Self.sessionsKey))
        sessions = Self.prune(stored)
        let key = UserDefaults.standard.string(forKey: Self.activeKeyDefault)
        activeKey = sessions.contains { $0.id == key } ? key : nil
        if sessions.count != stored.count { persist() }
    }

    /// Sessions on one server, most recently used first.
    func forServer(_ serverUrl: String) -> [StoredSession] {
        sessions.filter { $0.serverUrl == serverUrl }
    }

    func get(_ serverUrl: String, _ userId: Int) -> StoredSession? {
        sessions.first { $0.id == Self.key(serverUrl, userId) }
    }

    func save(_ session: StoredSession) {
        mutate { [session] + $0.filter { $0.id != session.id } }
    }

    func setActive(_ serverUrl: String, _ userId: Int) {
        activeKey = Self.key(serverUrl, userId)
        mutate { list in
            list.map { $0.id == Self.key(serverUrl, userId) ? touched($0) : $0 }
        }
    }

    func clearActive() {
        activeKey = nil
        persist()
    }

    func remove(_ serverUrl: String, _ userId: Int) {
        let key = Self.key(serverUrl, userId)
        if activeKey == key { activeKey = nil }
        mutate { $0.filter { $0.id != key } }
    }

    func updateTokens(_ serverUrl: String, _ userId: Int,
                      access: String?, refresh: String, refreshExpiresAt: Double?) {
        mutate { list in
            list.map { session in
                guard session.id == Self.key(serverUrl, userId) else { return session }
                var next = touched(session)
                next.accessToken = access
                next.refreshToken = refresh
                next.refreshExpiresAt = refreshExpiresAt
                return next
            }
        }
    }

    func updateUser(_ serverUrl: String, _ userId: Int, _ user: User) {
        mutate { list in
            list.map { session in
                guard session.id == Self.key(serverUrl, userId) else { return session }
                var next = session
                next.user = user
                return next
            }
        }
    }

    private func touched(_ session: StoredSession) -> StoredSession {
        var next = session
        next.lastUsedAt = Self.nowMs()
        return next
    }

    private func mutate(_ apply: ([StoredSession]) -> [StoredSession]) {
        sessions = Self.prune(apply(sessions))
        if !sessions.contains(where: { $0.id == activeKey }) { activeKey = nil }
        persist()
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(sessions), let json = String(data: data, encoding: .utf8) {
            Keychain.set(json, for: Self.sessionsKey)
        }
        if let activeKey {
            UserDefaults.standard.set(activeKey, forKey: Self.activeKeyDefault)
        } else {
            UserDefaults.standard.removeObject(forKey: Self.activeKeyDefault)
        }
    }

    private static func decode(_ raw: String?) -> [StoredSession] {
        guard let raw, let data = raw.data(using: .utf8),
              let list = try? JSONDecoder().decode([StoredSession].self, from: data) else { return [] }
        return list
    }

    /// Drop what can no longer be resumed, keep the newest within `maxSessions`.
    private static func prune(_ list: [StoredSession], now: Double = nowMs()) -> [StoredSession] {
        list.filter { !$0.refreshToken.isEmpty && ($0.refreshExpiresAt ?? .greatestFiniteMagnitude) > now }
            .sorted { $0.lastUsedAt > $1.lastUsedAt }
            .prefix(maxSessions)
            .map { $0 }
    }
}
