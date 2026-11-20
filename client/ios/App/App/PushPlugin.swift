import Capacitor
import CryptoKit
import UIKit
import UserNotifications

/// APNs registration and the per-session subscription (`client/src/app/core/plugins/push.plugin.ts`).
/// Keys and sessions live in `PushStore` so the notification service extension can decrypt.
@objc(PushPlugin)
public class PushPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PushPlugin"
    public let jsName = "Push"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "subscribe", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unsubscribe", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBadge", returnType: CAPPluginReturnPromise),
    ]

    private static weak var shared: PushPlugin?
    private static var pendingOpen: [String: Any]?
    private static var tokenWaiters: [UUID: CheckedContinuation<Void, Never>] = [:]

    override public func load() {
        Self.shared = self
        if let pending = Self.pendingOpen {
            Self.pendingOpen = nil
            notifyListeners("pushOpened", data: pending, retainUntilConsumed: true)
        }
    }

    // MARK: - Native entry points

    @MainActor
    static func didRegister(token: Data) {
        PushStore.token = token.map { String(format: "%02x", $0) }.joined()
        let waiters = tokenWaiters
        tokenWaiters = [:]
        waiters.values.forEach { $0.resume() }
    }

    /// A tapped notification, or the page of one of its actions. Held until the web layer has loaded.
    @MainActor
    static func opened(server: String, user: Int, url: String) {
        let data: [String: Any] = ["session": ["serverUrl": server, "userId": user, "key": "\(server)|\(user)"], "url": url]
        if let plugin = shared {
            plugin.notifyListeners("pushOpened", data: data, retainUntilConsumed: true)
        } else {
            pendingOpen = data
        }
    }

    /// Fresh token (it can change), or the stored one after `limit` seconds.
    @MainActor
    private static func registerForToken(limit: TimeInterval = 10) async -> String? {
        let id = UUID()
        await withCheckedContinuation { (waiter: CheckedContinuation<Void, Never>) in
            tokenWaiters[id] = waiter
            UIApplication.shared.registerForRemoteNotifications()
            DispatchQueue.main.asyncAfter(deadline: .now() + limit) {
                tokenWaiters.removeValue(forKey: id)?.resume()
            }
        }
        return PushStore.token
    }

    // MARK: - Methods

    @objc func status(_ call: CAPPluginCall) {
        Task {
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            call.resolve(["available": true, "permission": Self.permission(settings)])
        }
    }

    @objc func requestPermission(_ call: CAPPluginCall) {
        Task {
            let center = UNUserNotificationCenter.current()
            if await center.notificationSettings().authorizationStatus == .notDetermined {
                _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
            }
            call.resolve(["permission": Self.permission(await center.notificationSettings())])
        }
    }

    @objc func openSettings(_ call: CAPPluginCall) {
        Task { @MainActor in
            if let url = URL(string: UIApplication.openNotificationSettingsURLString) { await UIApplication.shared.open(url) }
            call.resolve()
        }
    }

    @objc func prepare(_ call: CAPPluginCall) {
        guard let session = call.getString("session") else { return call.reject("session is required") }
        Task { @MainActor in
            let center = UNUserNotificationCenter.current()
            guard Self.permission(await center.notificationSettings()) == "granted" else { return call.reject("notifications are denied") }
            guard await Self.registerForToken() != nil else { return call.reject("no push token") }
            var record = PushStore.subscription(session: session) ?? Self.newRecord(session)
            record.pendingDelete = false
            PushStore.save(record)
            call.resolve([
                "platform": "apns",
                "p256dh": record.key?.publicKey.x963Representation.base64URL ?? "",
                "auth": record.auth.base64URL,
            ])
        }
    }

    @objc func subscribe(_ call: CAPPluginCall) {
        guard let session = call.getString("session"), let sub = call.getString("sub"),
              let raw = call.getString("ticket"), let serverUrl = call.getString("serverUrl") else {
            return call.reject("session, sub, ticket and serverUrl are required")
        }
        guard let ticket = PushRelay.ticket(raw), ticket.sub == sub, let base = PushRelay.baseURL(audience: ticket.audience) else {
            return call.reject("ticket refused")
        }
        guard var record = PushStore.subscription(session: session), let token = PushStore.token else {
            return call.reject("prepare must run first")
        }
        record.serverUrl = serverUrl
        record.sub = sub
        record.relayKey = ticket.key
        record.relay = ticket.audience
        record.pendingDelete = false
        PushStore.save(record)
        let fingerprint = "\(ticket.audience)|\(token)|\(sub)|\(Self.environment)"
        guard record.putFingerprint != fingerprint else { return call.resolve() }
        Task {
            let status = await PushRelay.put(base, ticket: raw, token: token, environment: Self.environment)
            guard status == 204 else { return call.reject("relay answered \(status.map(String.init) ?? "nothing")") }
            record.putFingerprint = fingerprint
            PushStore.save(record)
            call.resolve()
        }
    }

    @objc func unsubscribe(_ call: CAPPluginCall) {
        guard let session = call.getString("session") else { return call.reject("session is required") }
        guard var record = PushStore.subscription(session: session) else { return call.resolve() }
        record.pendingDelete = true
        PushStore.save(record)
        Task {
            await PushNotifications.deletePending(record)
            call.resolve()
        }
    }

    @objc func setBadge(_ call: CAPPluginCall) {
        let count = max(call.getInt("count") ?? 0, 0)
        Task {
            try? await UNUserNotificationCenter.current().setBadgeCount(count)
            call.resolve()
        }
    }

    // MARK: - Helpers

    private static func permission(_ settings: UNNotificationSettings) -> String {
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral: return "granted"
        case .denied: return "denied"
        default: return "prompt"
        }
    }

    private static func newRecord(_ session: String) -> PushSubscription {
        let split = session.lastIndex(of: "|") ?? session.endIndex
        let userId = Int(session[session.index(after: split)...]) ?? 0
        return PushSubscription(
            session: session, serverUrl: String(session[..<split]), userId: userId,
            privateKey: P256.KeyAgreement.PrivateKey().rawRepresentation, auth: Data((0..<16).map { _ in UInt8.random(in: 0...255) }))
    }

    /// `aps-environment` of the embedded provisioning profile; no profile (App Store, TestFlight) is production.
    private static var environment: String {
        guard let path = Bundle.main.path(forResource: "embedded", ofType: "mobileprovision"),
              let text = (try? Data(contentsOf: URL(fileURLWithPath: path))).flatMap({ String(data: $0, encoding: .isoLatin1) }),
              text.range(of: #"aps-environment</key>\s*<string>development"#, options: .regularExpression) != nil else { return "production" }
        return "sandbox"
    }
}
