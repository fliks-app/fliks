import Foundation
import Security
import UIKit

struct KeychainError: LocalizedError {
    let status: OSStatus
    var errorDescription: String? { "Keychain error \(status)" }
}

/// The signed-in sessions: one JSON blob in the Keychain, written by the web layer through `SessionVault`, read and rotated natively.
/// Its own access group keeps it out of the push group the notification extension reads.
enum StoredSessions {
    static var service = "media.fliks.app.sessions"
    static var group: String? = (Bundle.main.object(forInfoDictionaryKey: "AppIdentifierPrefix") as? String)
        .flatMap { prefix in Bundle.main.bundleIdentifier.map { prefix + $0 } }
    static let account = "fliks_sessions"
    /// The `Preferences` key that held the blob before the Keychain.
    private static let legacyKey = "CapacitorStorage.fliks_sessions"
    private static var rotations: [String: Task<Bool?, Never>] = [:]

    static var readItem: () -> (status: OSStatus, data: Data?) = { Keychain.read(service: service, account: account, group: group) }
    static var writeItem: (Data) -> OSStatus = { Keychain.write(service: service, account: account, group: group, $0) }

    /// The stored blob, nil when empty. Any failed status throws: it is never an empty store.
    static func blob() throws -> String? {
        let (status, data) = readItem()
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data else { throw KeychainError(status: status) }
        return String(decoding: data, as: UTF8.self)
    }

    /// `blob()`, waiting for the first unlock after boot when the item cannot be read yet.
    @MainActor
    static func blobWhenUnlocked() async throws -> String? {
        do { return try blob() } catch let error as KeychainError where error.status == errSecInteractionNotAllowed {
            await withCheckedContinuation { (resume: CheckedContinuation<Void, Never>) in
                var observer: NSObjectProtocol?
                var done = false
                let finish = {
                    guard !done else { return }
                    done = true
                    if let observer { NotificationCenter.default.removeObserver(observer) }
                    resume.resume()
                }
                observer = NotificationCenter.default.addObserver(
                    forName: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil, queue: .main) { _ in finish() }
                // The unlock can land between the failed read and the observer.
                if readItem().status != errSecInteractionNotAllowed { finish() }
            }
            migrate()
            return try blob()
        }
    }

    static func store(_ blob: String) throws {
        let status = writeItem(Data(blob.utf8))
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    @discardableResult
    static func clear() -> OSStatus { Keychain.remove(service: service, account: account, group: group) }

    static let installedKey = "fliks.push.installed"

    /// Launch work before the WebView loads. The reset comes first: builds before 7.1 set no flag,
    /// so a reset after the migration would sign every upgrading user out.
    static func launch() {
        resetAfterReinstall()
        migrate()
    }

    /// Keychain items outlive an uninstall, `UserDefaults` does not: a launch with no flag starts clean.
    /// Skipped while the sessions item is unreadable (before the first unlock after boot), when the flag cannot be read either.
    static func resetAfterReinstall() {
        guard !UserDefaults.standard.bool(forKey: installedKey), readItem().status != errSecInteractionNotAllowed else { return }
        UserDefaults.standard.set(true, forKey: installedKey)
        let token = PushStore.token
        PushStore.wipe()
        clear()
        if let token { Task { _ = await PushRelay.delete(PushRelay.defaultURL, token: token, sub: nil) } }
    }

    /// Moves the blob out of `UserDefaults`, where backups carry it. The key is deleted once the Keychain holds the
    /// value; a failed write or an unreadable item leaves it for the next launch.
    static func migrate() {
        guard let legacy = UserDefaults.standard.string(forKey: legacyKey) else { return }
        let (status, _) = readItem()
        if status == errSecItemNotFound {
            guard writeItem(Data(legacy.utf8)) == errSecSuccess, (try? blob()) == legacy else { return }
        } else if status != errSecSuccess {
            return
        }
        UserDefaults.standard.removeObject(forKey: legacyKey)
    }

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
        guard let stored = try? await listWhenUnlocked() else { return nil }
        guard let current = stored.first(where: { rowKey($0) == key }) else { return false }
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
        guard var all = try? await listWhenUnlocked() else { return nil }
        guard let i = all.firstIndex(where: { rowKey($0) == key }) else { return false }
        let expires = (pair["refreshTokenExpiresAt"] as? NSNumber)?.int64Value ?? 0
        all[i]["accessToken"] = access
        all[i]["refreshToken"] = next
        all[i]["refreshExpiresAt"] = expires > 0 ? expires * 1000 : NSNull()
        all[i]["tokenVersion"] = ((all[i]["tokenVersion"] as? NSNumber)?.intValue ?? 0) + 1
        guard let out = try? JSONSerialization.data(withJSONObject: all),
              (try? store(String(decoding: out, as: UTF8.self))) != nil else { return nil }
        return true
    }

    /// An unreadable store is an empty list here: callers act on a session only when they find it.
    private static func list() -> [[String: Any]] { (try? parse(blob())) ?? [] }

    private static func listWhenUnlocked() async throws -> [[String: Any]] { parse(try await blobWhenUnlocked()) }

    private static func parse(_ raw: String?) -> [[String: Any]] {
        raw.flatMap { (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [[String: Any]] } ?? []
    }

    private static func rowKey(_ row: [String: Any]) -> String {
        key(row["serverUrl"] as? String ?? "", ((row["user"] as? [String: Any])?["id"] as? NSNumber)?.intValue ?? 0)
    }

    private static func normalisedKey(_ raw: String) -> String {
        guard let split = raw.range(of: "::", options: .backwards) else { return raw }
        return key(String(raw[..<split.lowerBound]), Int(raw[split.upperBound...]) ?? 0)
    }
}
