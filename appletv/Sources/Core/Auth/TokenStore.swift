import Foundation
import Security

/// Minimal SecItem wrapper — this app stores exactly two secrets, not worth a framework.
private enum Keychain {
    static func set(_ value: String, for key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
        var attrs = query
        attrs[kSecValueData as String] = Data(value.utf8)
        attrs[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(attrs as CFDictionary, nil)
    }

    static func get(for key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete(for key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

/// Access + refresh JWT, persisted in the Keychain. `APIClient` reads
/// `accessToken` directly; P2's AuthService owns writing both tokens
/// (login, refresh rotation, pairing) and clearing them (logout).
@Observable final class TokenStore {
    static let shared = TokenStore()

    private static let accessKey = "fliks_access_token"
    private static let refreshKey = "fliks_refresh_token"

    var accessToken: String? {
        didSet { persist(accessToken, key: Self.accessKey) }
    }
    var refreshToken: String? {
        didSet { persist(refreshToken, key: Self.refreshKey) }
    }

    private init() {
        accessToken = Keychain.get(for: Self.accessKey)
        refreshToken = Keychain.get(for: Self.refreshKey)
    }

    func setTokens(access: String, refresh: String) {
        accessToken = access
        refreshToken = refresh
    }

    func clear() {
        accessToken = nil
        refreshToken = nil
    }

    private func persist(_ value: String?, key: String) {
        if let value {
            Keychain.set(value, for: key)
        } else {
            Keychain.delete(for: key)
        }
    }
}
