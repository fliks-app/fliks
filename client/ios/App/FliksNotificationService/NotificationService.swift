import UniformTypeIdentifiers
import UserNotifications

/// Decrypts the push and attaches its image. No Capacitor here: the extension has about 30 s and 24 MB.
final class NotificationService: UNNotificationServiceExtension {
    private static let imageBudget: TimeInterval = 8
    private static let imageLimit = 8 << 20
    private static let imageTypes: [String: (ext: String, type: UTType)] = [
        "image/jpeg": ("jpg", .jpeg), "image/png": ("png", .png), "image/gif": ("gif", .gif), "image/webp": ("webp", .webP),
    ]

    private let lock = NSLock()
    private var handler: ((UNNotificationContent) -> Void)?
    private var content = UNMutableNotificationContent()

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        lock.withLock {
            handler = contentHandler
            content = (request.content.mutableCopy() as? UNMutableNotificationContent) ?? content
        }
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
            // The atomic mark settles two instances racing on the same id.
            guard PushStore.markSeen(message.id) else { break }
            mutate { fill($0, message, record) }
            if let tag = message.tag { await removeDelivered(tag: tag) }
            if let path = message.image, let attachment = await download(record.serverUrl, path) { mutate { $0.attachments = [attachment] } }
        }
        deliver()
    }

    private func fill(_ content: UNMutableNotificationContent, _ message: PushMessage, _ record: PushSubscription) {
        content.title = message.title
        content.body = message.body
        content.sound = .default
        content.threadIdentifier = "\(record.session)|\(message.cat)"
        if let badge = message.badge { content.badge = NSNumber(value: badge) }
        let actions = (message.actions ?? []).map { a in
            ["id": a.id, "title": a.title, "kind": a.kind, "url": a.url ?? "", "token": a.token ?? "", "done": a.done ?? ""]
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
        guard path.hasPrefix("/"), !path.hasPrefix("//"), let url = URL(string: server + path),
              let (file, mime) = await ImageFetch(limit: Self.imageLimit, budget: Self.imageBudget).fetch(url),
              let kind = mime.flatMap({ Self.imageTypes[$0] }) else { return nil }
        let target = file.deletingPathExtension().appendingPathExtension(kind.ext)
        try? FileManager.default.moveItem(at: file, to: target)
        return try? UNNotificationAttachment(identifier: "image", url: target, options: [UNNotificationAttachmentOptionsTypeHintKey: kind.type.identifier])
    }

    /// Content changes stop once it was handed over.
    private func mutate(_ change: (UNMutableNotificationContent) -> Void) {
        lock.withLock { if handler != nil { change(content) } }
    }

    private func deliver() {
        lock.withLock {
            handler?(content)
            handler = nil
        }
    }
}

/// One image download: no redirect, `limit` bytes at most (checked on the header and while it streams), `budget` seconds.
private final class ImageFetch: NSObject, URLSessionDownloadDelegate {
    private let limit: Int
    private let budget: TimeInterval
    private var done: CheckedContinuation<(URL, String?)?, Never>?
    private var file: URL?
    private var mime: String?

    init(limit: Int, budget: TimeInterval) {
        self.limit = limit
        self.budget = budget
    }

    func fetch(_ url: URL) async -> (URL, String?)? {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForResource = budget
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        return await withCheckedContinuation { continuation in
            done = continuation
            session.downloadTask(with: url).resume()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        if totalBytesWritten > limit || totalBytesExpectedToWrite > limit { downloadTask.cancel() }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let http = downloadTask.response as? HTTPURLResponse, http.statusCode == 200 else { return }
        let kept = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        if (try? FileManager.default.moveItem(at: location, to: kept)) != nil {
            file = kept
            mime = http.mimeType
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        done?.resume(returning: error == nil ? file.map { ($0, mime) } : nil)
        done = nil
    }
}
