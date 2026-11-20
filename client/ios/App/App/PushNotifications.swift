import UIKit
import UserNotifications

/// The app side of a push that is not the plugin's: launch work, the foreground rule, taps and background actions.
enum PushNotifications {
    private static let installedKey = "fliks.push.installed"

    /// Everything the extension left under the `fliks` key of the content.
    struct Info {
        let server: String
        let user: Int
        let url: String
        let actions: [[String: String]]

        init?(_ notification: UNNotification) { self.init(notification.request.content.userInfo) }

        init?(_ userInfo: [AnyHashable: Any]) {
            guard let raw = userInfo["fliks"] as? [String: Any],
                  let server = raw["serverUrl"] as? String, let user = raw["userId"] as? Int else { return nil }
            self.server = server
            self.user = user
            url = raw["url"] as? String ?? "/"
            actions = raw["actions"] as? [[String: String]] ?? []
        }
    }

    static func start() {
        resetAfterReinstall()
        registerCategories()
        Task {
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            if settings.authorizationStatus == .authorized {
                await MainActor.run { UIApplication.shared.registerForRemoteNotifications() }
            }
            for record in PushStore.subscriptions() ?? [] where record.pendingDelete { await deletePending(record) }
        }
    }

    /// Keychain items outlive an uninstall, the sessions in `UserDefaults` do not: a launch with no flag starts clean.
    private static func resetAfterReinstall() {
        guard !UserDefaults.standard.bool(forKey: installedKey) else { return }
        UserDefaults.standard.set(true, forKey: installedKey)
        let token = PushStore.token
        PushStore.wipe()
        if let token { Task { _ = await PushRelay.delete(PushRelay.defaultURL, token: token, sub: nil) } }
    }

    private static func registerCategories() {
        let categories = PushCategories.sets.map { ids in
            UNNotificationCategory(
                identifier: PushCategories.identifier(ids),
                actions: ids.map { id in
                    UNNotificationAction(identifier: id, title: BundledText["push.action.\(id)"] ?? id, options: PushCategories.opening.contains(id) ? [.foreground] : [])
                },
                intentIdentifiers: [])
        }
        UNUserNotificationCenter.current().setNotificationCategories(Set(categories))
    }

    /// The key is erased only once the relay confirmed; a failure leaves it for the next launch.
    static func deletePending(_ record: PushSubscription) async {
        guard let sub = record.sub, let token = PushStore.token else { return PushStore.remove(session: record.session) }
        let base = record.relay.flatMap { PushRelay.baseURL(audience: $0) } ?? PushRelay.defaultURL
        if await PushRelay.delete(base, token: token, sub: sub) == 204 { PushStore.remove(session: record.session) }
    }

    // MARK: - Delegate

    /// A push for the session on screen is the page's toast; any other shows as a banner.
    static func presentation(_ notification: UNNotification) -> UNNotificationPresentationOptions {
        if let info = Info(notification), StoredSessions.key(info.server, info.user) == StoredSessions.activeKey { return [] }
        return [.banner, .sound, .list]
    }

    static func respond(_ response: UNNotificationResponse) async {
        guard let info = Info(response.notification) else { return }
        let action = info.actions.first { $0["id"] == response.actionIdentifier }
        switch response.actionIdentifier {
        case UNNotificationDismissActionIdentifier:
            return
        case UNNotificationDefaultActionIdentifier:
            await open(info, info.url)
        default:
            guard action?["kind"] == "call", let token = action?["token"] else { return await open(info, action?["url"].flatMap { $0.isEmpty ? nil : $0 } ?? info.url) }
            await call(token, info, response.notification.request.identifier)
        }
    }

    @MainActor
    private static func open(_ info: Info, _ url: String) {
        PushPlugin.opened(server: info.server, user: info.user, url: url)
    }

    /// Runs a `call` action with the stored session (no refresh here): a 401 asks the user to open the app.
    static func call(_ token: String, _ info: Info, _ id: String) async {
        let background = await UIApplication.shared.beginBackgroundTask(withName: "fliks.push.act")
        defer { Task { @MainActor in UIApplication.shared.endBackgroundTask(background) } }
        var outcome = "outcome_signin"
        if let session = StoredSessions.find(StoredSessions.key(info.server, info.user)),
           let url = URL(string: session.server + "/api/push/act") {
            var request = URLRequest(url: url, timeoutInterval: 20)
            request.httpMethod = "POST"
            request.httpBody = try? JSONSerialization.data(withJSONObject: ["token": token])
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("Bearer \(session.token)", forHTTPHeaderField: "Authorization")
            let status = (try? await URLSession.shared.data(for: request)).flatMap { ($0.1 as? HTTPURLResponse)?.statusCode }
            outcome = status.map { (200..<300).contains($0) ? "outcome_done" : $0 == 401 ? "outcome_signin" : "outcome_failed" } ?? "outcome_failed"
        }
        let content = UNMutableNotificationContent()
        content.title = BundledText["push.\(outcome)"] ?? outcome
        content.userInfo = ["fliks": ["serverUrl": info.server, "userId": info.user, "url": info.url, "actions": [[String: String]]()] as [String: Any]]
        let center = UNUserNotificationCenter.current()
        center.removeDeliveredNotifications(withIdentifiers: [id])
        try? await center.add(UNNotificationRequest(identifier: "fliks.act.\(id)", content: content, trigger: nil))
    }
}
