import Foundation

/// Stable per-installation identifier, sent as `X-Device-Id` on pairing
/// (quick-connect) requests. Not a secret — plain UserDefaults, same as
/// the Angular client's `getOrCreateDeviceId`.
enum DeviceId {
    private static let key = "fliks_device_id"

    static let current: String = {
        let defaults = UserDefaults.standard
        if let existing = defaults.string(forKey: key) { return existing }
        let id = UUID().uuidString
        defaults.set(id, forKey: key)
        return id
    }()
}
