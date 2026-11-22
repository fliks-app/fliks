import Foundation
import Security
import os

/// Minimal SecItem wrapper. Simulator builds must be signed (see
/// `scripts/remote-build.sh`) or every call here fails with -34018.
enum Keychain {
    /// Updates the item in place, adding it only when absent: a failed write never deletes what was stored.
    @discardableResult
    static func set(_ value: String, for key: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
        ]
        let data = Data(value.utf8)
        var status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var attrs = query
            attrs[kSecValueData as String] = data
            attrs[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            status = SecItemAdd(attrs as CFDictionary, nil)
        }
        if status != errSecSuccess { Log.auth.error("keychain write for \(key, privacy: .public) failed: OSStatus \(status, privacy: .public)") }
        return status == errSecSuccess
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
