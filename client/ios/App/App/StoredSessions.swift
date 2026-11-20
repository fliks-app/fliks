import Foundation

/// The signed-in sessions the web layer keeps in `Preferences` (`UserDefaults`), read natively.
enum StoredSessions {
    static func key(_ server: String, _ user: Int) -> String { "\(server)::\(user)" }

    static var activeKey: String? { UserDefaults.standard.string(forKey: "CapacitorStorage.fliks_active_session") }

    static func find(_ key: String) -> (server: String, token: String)? {
        guard let raw = UserDefaults.standard.string(forKey: "CapacitorStorage.fliks_sessions"),
              let list = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [[String: Any]] else { return nil }
        for s in list {
            let server = s["serverUrl"] as? String ?? ""
            let user = ((s["user"] as? [String: Any])?["id"] as? NSNumber)?.intValue ?? 0
            if Self.key(server, user) == key, let token = s["accessToken"] as? String, !token.isEmpty { return (server, token) }
        }
        return nil
    }
}
