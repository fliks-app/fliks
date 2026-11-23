import Capacitor
import Foundation
import Security

/// The web layer's access to the sessions blob in the Keychain (`client/src/app/core/plugins/session-vault.plugin.ts`).
/// A failed status rejects: the web layer must never read a Keychain failure as "no sessions".
@objc(SessionVaultPlugin)
public class SessionVaultPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SessionVaultPlugin"
    public let jsName = "SessionVault"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
    ]

    private func accepts(_ call: CAPPluginCall) -> Bool {
        guard call.getString("key") == StoredSessions.account else {
            call.reject("Unsupported key")
            return false
        }
        return true
    }

    @objc func get(_ call: CAPPluginCall) {
        guard accepts(call) else { return }
        Task { @MainActor in
            do {
                call.resolve(try await StoredSessions.blobWhenUnlocked().map { ["value": $0] } ?? [:])
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func set(_ call: CAPPluginCall) {
        guard accepts(call) else { return }
        guard let value = call.getString("value") else { return call.reject("value is required") }
        do {
            try StoredSessions.store(value)
            call.resolve()
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard accepts(call) else { return }
        let status = StoredSessions.clear()
        if status == errSecSuccess || status == errSecItemNotFound { call.resolve() } else { call.reject("Keychain error \(status)") }
    }
}
