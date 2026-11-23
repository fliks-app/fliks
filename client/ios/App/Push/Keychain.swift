import Foundation
import Security

/// Generic-password items of one service. Every call returns its `OSStatus`, so a caller can tell empty from failed.
enum Keychain {
    static func query(service: String, account: String? = nil, group: String? = nil) -> [String: Any] {
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        if let account { query[kSecAttrAccount as String] = account }
        if let group { query[kSecAttrAccessGroup as String] = group }
        return query
    }

    static func read(service: String, account: String, group: String? = nil) -> (status: OSStatus, data: Data?) {
        var query = query(service: service, account: account, group: group)
        query[kSecReturnData as String] = true
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        return (status, status == errSecSuccess ? out as? Data : nil)
    }

    /// Items are `AfterFirstUnlockThisDeviceOnly`: readable while locked once unlocked after boot, never in a backup.
    @discardableResult
    static func write(service: String, account: String, group: String? = nil, _ data: Data) -> OSStatus {
        let base = query(service: service, account: account, group: group)
        let update = SecItemUpdate(base as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        guard update == errSecItemNotFound else { return update }
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil)
    }

    @discardableResult
    static func remove(service: String, account: String, group: String? = nil) -> OSStatus {
        SecItemDelete(query(service: service, account: account, group: group) as CFDictionary)
    }
}
