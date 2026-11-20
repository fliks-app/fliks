import UniformTypeIdentifiers
import UserNotifications

/// Decrypts the push and attaches its image. No Capacitor here: the extension has about 30 s and 24 MB.
final class NotificationService: UNNotificationServiceExtension {
    private static let imageBudget: TimeInterval = 8
    private static let imageLimit = 8 << 20

    private let lock = NSLock()
    private var handler: ((UNNotificationContent) -> Void)?
    private var content = UNMutableNotificationContent()

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        handler = contentHandler
        content = (request.content.mutableCopy() as? UNMutableNotificationContent) ?? content
        Task { await process(request) }
    }

    override func serviceExtensionTimeWillExpire() { deliver() }

    private func process(_ request: UNNotificationRequest) async {
        let outcome = PushPipeline.evaluate(request.content.userInfo, subscriptions: PushStore.subscriptions(), seen: PushStore.seenIDs())
        switch outcome {
        case .fallback:
            break
        case .unknown(let sub):
            if let token = PushStore.token { _ = await PushRelay.delete(PushRelay.defaultURL, token: token, sub: sub) }
        case .show(let message, let record):
            PushStore.markSeen(message.id)
            fill(message, record)
            if let tag = message.tag { await removeDelivered(tag: tag) }
            if let path = message.image, let attachment = await download(record.serverUrl, path) { content.attachments = [attachment] }
        }
        deliver()
    }

    private func fill(_ message: PushMessage, _ record: PushSubscription) {
        content.title = message.title
        content.body = message.body
        content.sound = .default
        content.threadIdentifier = "\(record.session)|\(message.cat)"
        if let badge = message.badge { content.badge = NSNumber(value: badge) }
        let actions = (message.actions ?? []).map { a in
            ["id": a.id, "title": a.title, "kind": a.kind, "url": a.url ?? "", "token": a.token ?? ""]
        }
        if !actions.isEmpty { content.categoryIdentifier = PushCategories.identifier(actions.compactMap { $0["id"] }) }
        content.userInfo = ["fliks": [
            "serverUrl": record.serverUrl, "userId": record.userId, "url": message.url, "tag": message.tag ?? "", "actions": actions,
        ] as [String: Any]]
    }

    private func removeDelivered(tag: String) async {
        let center = UNUserNotificationCenter.current()
        let stale = await center.deliveredNotifications().filter { ($0.request.content.userInfo["fliks"] as? [String: Any])?["tag"] as? String == tag }
        center.removeDeliveredNotifications(withIdentifiers: stale.map { $0.request.identifier })
    }

    private func download(_ server: String, _ path: String) async -> UNNotificationAttachment? {
        guard path.hasPrefix("/"), !path.hasPrefix("//"), let url = URL(string: server + path) else { return nil }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForResource = Self.imageBudget
        guard let (file, response) = try? await URLSession(configuration: config).download(from: url),
              (response as? HTTPURLResponse)?.statusCode == 200,
              ((try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? Int.max) <= Self.imageLimit,
              let type = response.mimeType.flatMap({ UTType(mimeType: $0) }), let ext = type.preferredFilenameExtension else { return nil }
        let target = file.deletingPathExtension().appendingPathExtension(ext)
        try? FileManager.default.moveItem(at: file, to: target)
        return try? UNNotificationAttachment(identifier: "image", url: target)
    }

    private func deliver() {
        lock.lock()
        defer { lock.unlock() }
        handler?(content)
        handler = nil
    }
}
