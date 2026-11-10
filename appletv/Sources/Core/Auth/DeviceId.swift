import UIKit

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

/// The name this device shows on other devices.
enum DeviceName {
    static let current = resolve(name: UIDevice.current.name, model: model)

    /// tvOS reports the product class as the name without the device-name entitlement: the model says more.
    static func resolve(name: String, model: String) -> String {
        name == "Apple TV" ? labels[model] ?? name : name
    }

    private static let labels = [
        "AppleTV5,3": "Apple TV HD",
        "AppleTV6,2": "Apple TV 4K",
        "AppleTV11,1": "Apple TV 4K (2nd generation)",
        "AppleTV14,1": "Apple TV 4K (3rd generation)",
    ]

    private static var model: String {
        if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return simulated }
        var info = utsname()
        uname(&info)
        return withUnsafeBytes(of: &info.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
    }
}
