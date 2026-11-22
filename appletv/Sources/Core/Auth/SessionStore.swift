import Foundation
import os

/// What a stored session keeps of the server's `User`: the picker and the offline boot need no more, and
/// a field a later release adds to `User` cannot make every stored session unreadable.
struct StoredProfile: Codable, Hashable {
    let id: Int
    let username: String
    let avatar: String?
    let isAdmin: Bool
    let permissions: [String]
    let libraryOrder: [Int]
    let hiddenLibraryIds: [Int]

    init(_ user: User) {
        id = user.id
        username = user.username
        avatar = user.avatar
        isAdmin = user.isAdmin
        permissions = user.permissions
        libraryOrder = user.libraryOrder
        hiddenLibraryIds = user.hiddenLibraryIds
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        username = try c.decode(String.self, forKey: .username)
        avatar = try c.decodeIfPresent(String.self, forKey: .avatar)
        isAdmin = try c.decodeIfPresent(Bool.self, forKey: .isAdmin) ?? false
        permissions = try c.decodeIfPresent([String].self, forKey: .permissions) ?? []
        libraryOrder = try c.decodeIfPresent([Int].self, forKey: .libraryOrder) ?? []
        hiddenLibraryIds = try c.decodeIfPresent([Int].self, forKey: .hiddenLibraryIds) ?? []
    }
}

/// Credentials of one account on one server, kept so the user can leave it and
/// come back without re-authenticating. `user` is the last known profile: it
/// drives the picker and the offline boot.
struct StoredSession: Codable, Identifiable, Hashable {
    var serverUrl: String
    var user: StoredProfile
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
                next.user = StoredProfile(user)
                return next
            }
        }
    }

    /// The server's address changed (http to https): its sessions follow, the older of two for one
    /// account is dropped, and the active pointer moves with them.
    func rekey(from previous: String, to current: String) {
        guard previous != current else { return }
        if let active, active.serverUrl == previous { activeKey = Self.key(current, active.user.id) }
        var seen = Set<String>()
        mutate { list in
            list.map { session in
                guard session.serverUrl == previous else { return session }
                var next = session
                next.serverUrl = current
                return next
            }
            .sorted { $0.lastUsedAt > $1.lastUsedAt }
            .filter { seen.insert($0.id).inserted }
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
        guard let raw, let data = raw.data(using: .utf8) else { return [] }
        do {
            return try JSONDecoder().decode(LossyArray<StoredSession>.self, from: data).elements
        } catch {
            Log.auth.error("stored sessions unreadable: \(String(describing: error), privacy: .public)")
            return []
        }
    }

    /// Drop what can no longer be resumed, keep the newest within `maxSessions`.
    private static func prune(_ list: [StoredSession], now: Double = nowMs()) -> [StoredSession] {
        list.filter { !$0.refreshToken.isEmpty && ($0.refreshExpiresAt ?? .greatestFiniteMagnitude) > now }
            .sorted { $0.lastUsedAt > $1.lastUsedAt }
            .prefix(maxSessions)
            .map { $0 }
    }
}
