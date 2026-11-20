import CryptoKit
import Foundation
import Security

/// One subscription of one signed-in session, kept in the shared keychain group so the extension can decrypt.
struct PushSubscription: Codable, Equatable {
    var session: String
    var serverUrl: String
    var userId: Int
    var privateKey: Data
    var auth: Data
    var sub: String?
    var relayKey: String?
    var relay: String?
    var putFingerprint: String?
    var pendingDelete = false

    var key: P256.KeyAgreement.PrivateKey? { try? P256.KeyAgreement.PrivateKey(rawRepresentation: privateKey) }
}

/// Items are `AfterFirstUnlockThisDeviceOnly`; the access group is the app's only one, shared with the extension.
enum PushStore {
    static var service = "media.fliks.app.push"
    static let replayLimit = 200
    private static let tokenAccount = "_token"
    private static let replayAccount = "_replay"

    /// Nil when the keychain cannot be read yet (before the first unlock).
    static func subscriptions() -> [PushSubscription]? {
        var query = base()
        query[kSecMatchLimit as String] = kSecMatchLimitAll
        query[kSecReturnAttributes as String] = true
        query[kSecReturnData as String] = true
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess, let rows = out as? [[String: Any]] else { return nil }
        return rows.compactMap { row in
            guard let account = row[kSecAttrAccount as String] as? String, !account.hasPrefix("_"),
                  let data = row[kSecValueData as String] as? Data else { return nil }
            return try? JSONDecoder().decode(PushSubscription.self, from: data)
        }
    }

    static func subscription(session: String) -> PushSubscription? {
        read(session).flatMap { try? JSONDecoder().decode(PushSubscription.self, from: $0) }
    }

    static func save(_ subscription: PushSubscription) {
        if let data = try? JSONEncoder().encode(subscription) { write(subscription.session, data) }
    }

    static func remove(session: String) { remove(account: session) }

    static var token: String? {
        get { read(tokenAccount).flatMap { String(data: $0, encoding: .utf8) } }
        set { newValue.map { write(tokenAccount, Data($0.utf8)) } ?? remove(account: tokenAccount) }
    }

    static func seenIDs() -> [String] {
        read(replayAccount).flatMap { try? JSONDecoder().decode([String].self, from: $0) } ?? []
    }

    static func markSeen(_ id: String) {
        let ids = Array((seenIDs() + [id]).suffix(replayLimit))
        if let data = try? JSONEncoder().encode(ids) { write(replayAccount, data) }
    }

    static func wipe() { SecItemDelete(base() as CFDictionary) }

    private static func base(_ account: String? = nil) -> [String: Any] {
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        if let account { query[kSecAttrAccount as String] = account }
        return query
    }

    private static func read(_ account: String) -> Data? {
        var query = base(account)
        query[kSecReturnData as String] = true
        var out: CFTypeRef?
        return SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
    }

    private static func write(_ account: String, _ data: Data) {
        let update = SecItemUpdate(base(account) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        guard update == errSecItemNotFound else { return }
        var add = base(account)
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }

    private static func remove(account: String) { SecItemDelete(base(account) as CFDictionary) }
}
