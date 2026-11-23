import UIKit
import UserNotifications

/// The app side of a push that is not the plugin's: launch work, the foreground rule, taps and background actions.
enum PushNotifications {
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
        registerCategories()
        Task {
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            if settings.authorizationStatus == .authorized {
                await MainActor.run { UIApplication.shared.registerForRemoteNotifications() }
            }
            for record in PushStore.subscriptions() ?? [] where record.pendingDelete { await deletePending(record) }
        }
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
        if let info = Info(notification), StoredSessions.isActive(info.server, info.user) { return [] }
        return [.banner, .sound, .list]
    }

    static func respond(_ response: UNNotificationResponse) async {
        guard let info = Info(response.notification) else { return }
        switch response.actionIdentifier {
        case UNNotificationDismissActionIdentifier:
            return
        case UNNotificationDefaultActionIdentifier:
            await open(info, info.url)
        default:
            // An id the payload does not carry is ignored; only a foreground action may open the app.
            guard let action = info.actions.first(where: { $0["id"] == response.actionIdentifier }) else { return }
            if action["kind"] == "call", let token = action["token"] {
                await call(token, done: action["done"], info, response.notification.request.identifier)
            } else if PushCategories.opening.contains(response.actionIdentifier) {
                await open(info, action["url"].flatMap { $0.isEmpty ? nil : $0 } ?? info.url)
            }
        }
    }

    @MainActor
    private static func open(_ info: Info, _ url: String) {
        PushPlugin.opened(server: info.server, user: info.user, url: url)
    }

    /// Runs a `call` action with the stored session; a 401 rotates the stored pair once and retries.
    /// "Open Fliks" is asked only when the server refuses the refresh token or the session is gone.
    static func call(_ token: String, done: String?, _ info: Info, _ id: String) async {
        let background = await UIApplication.shared.beginBackgroundTask(withName: "fliks.push.act")
        defer { Task { @MainActor in UIApplication.shared.endBackgroundTask(background) } }
        let key = StoredSessions.key(info.server, info.user)
        var outcome = "outcome_signin"
        if var session = StoredSessions.find(key) {
            var status = await post(session, token)
            if status == 401 {
                switch await StoredSessions.refresh(key, rejected: session.token) {
                case true?:
                    if let renewed = StoredSessions.find(key) { session = renewed }
                    status = await post(session, token)
                case false?: break
                case nil: status = nil
                }
            }
            outcome = status.map { (200..<300).contains($0) ? "outcome_done" : $0 == 401 ? "outcome_signin" : "outcome_failed" } ?? "outcome_failed"
        }
        let content = UNMutableNotificationContent()
        let generic = BundledText["push.\(outcome)"] ?? outcome
        content.title = outcome == "outcome_done" ? done.flatMap { $0.isEmpty ? nil : $0 } ?? generic : generic
        content.userInfo = ["fliks": ["serverUrl": info.server, "userId": info.user, "url": info.url, "actions": [[String: String]]()] as [String: Any]]
        let center = UNUserNotificationCenter.current()
        center.removeDeliveredNotifications(withIdentifiers: [id])
        try? await center.add(UNNotificationRequest(identifier: "fliks.act.\(id)", content: content, trigger: nil))
    }

    private static func post(_ session: (server: String, token: String), _ token: String) async -> Int? {
        guard let url = URL(string: session.server + "/api/push/act") else { return nil }
        var request = URLRequest(url: url, timeoutInterval: 20)
        request.httpMethod = "POST"
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["token": token])
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(session.token)", forHTTPHeaderField: "Authorization")
        return (try? await URLSession.shared.data(for: request)).flatMap { ($0.1 as? HTTPURLResponse)?.statusCode }
    }
}
