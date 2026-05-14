import Foundation
import ServiceManagement

/// Persists user preferences across launches.
///
/// Backed by UserDefaults with suite name `app.fliks.macos` so
/// settings survive even if the app bundle moves.
@MainActor
final class ConfigStore: ObservableObject {

    private let defaults: UserDefaults

    @Published var port: UInt16 {
        didSet { defaults.set(Int(port), forKey: "port") }
    }

    @Published var pgPort: UInt16 {
        didSet { defaults.set(Int(pgPort), forKey: "pgPort") }
    }

    @Published var hasCompletedFirstLaunch: Bool {
        didSet { defaults.set(hasCompletedFirstLaunch, forKey: "hasCompletedFirstLaunch") }
    }

    var startAtLogin: Bool {
        get { SMAppService.mainApp.status == .enabled }
        set {
            objectWillChange.send()
            do {
                if newValue {
                    try SMAppService.mainApp.register()
                } else {
                    try SMAppService.mainApp.unregister()
                }
            } catch {
                // Silently fail — user can toggle again.
            }
        }
    }

    init() {
        let defaults = UserDefaults(suiteName: "app.fliks.macos") ?? .standard
        self.defaults = defaults
        self.port = UInt16(defaults.integer(forKey: "port")).nonZero ?? 4848
        self.pgPort = UInt16(defaults.integer(forKey: "pgPort")).nonZero ?? 5433
        self.hasCompletedFirstLaunch = defaults.bool(forKey: "hasCompletedFirstLaunch")
    }
}

private extension UInt16 {
    /// Returns `nil` for zero (UserDefaults returns 0 for missing keys).
    var nonZero: UInt16? { self == 0 ? nil : self }
}
