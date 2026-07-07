import Capacitor
import AVFoundation
import UserNotifications

/// Holds the completion handler iOS hands us when it relaunches the app in the
/// background to finish delivering events for our background `URLSession`.
///
/// `AppDelegate.application(_:handleEventsForBackgroundURLSession:)` stores it
/// here; the session's `urlSessionDidFinishEvents(forBackgroundURLSession:)`
/// delegate callback invokes and clears it once all queued events have been
/// dispatched. Failing to call it makes the OS consider the app misbehaving and
/// throttles future background transfers. Keyed by the session identifier so a
/// stray handler for another session can't be consumed by ours.
enum BackgroundDownloadCompletion {
    static let sessionIdentifier = "media.fliks.app.download"
    static var handler: (() -> Void)?
}

/**
 * Capacitor plugin for offline HLS downloads on iOS — the AVFoundation
 * counterpart of the Android `DownloadNotificationPlugin` (ExoPlayer).
 *
 * Downloads run through a single background `AVAssetDownloadURLSession`, so the
 * OS keeps them alive while the app is suspended, the screen is locked, or the
 * app is terminated — no foreground service or idle-timer juggling is needed
 * (that is the iOS-idiomatic equivalent of Android's foreground download
 * service that also blocks device sleep). Each finished download is a local
 * `.movpkg` bundle that `AVURLAsset` plays natively offline.
 *
 * Contract shared with the WebView / Android (see download-notification.service.ts):
 *   methods  startDownload / removeDownload / getDownloads / isDownloaded
 *            / getOfflineUrl / pauseDownloads / resumeDownloads
 *   events   downloadProgress | downloadComplete | downloadFailed | downloadRemoved
 *            each carrying { id, progress, state }
 */
@objc(DownloadNotification)
public class DownloadPlugin: CAPPlugin, CAPBridgedPlugin, AVAssetDownloadDelegate {
    public let identifier = "DownloadNotification"
    public let jsName = "DownloadNotification"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startDownload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeDownload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDownloads", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isDownloaded", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getOfflineUrl", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pauseDownloads", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resumeDownloads", returnType: CAPPluginReturnPromise),
    ]

    /// UserDefaults key under which the id → relative-path map is persisted.
    private static let assetsDefaultsKey = "fliks_offline_assets"

    private var downloadSession: AVAssetDownloadURLSession!
    /// taskDescription (our download id) → active aggregate download task.
    private var activeTasks: [String: AVAggregateAssetDownloadTask] = [:]
    /// id → last progress percentage (0–100) seen from the delegate. HLS byte
    /// counts are unreliable for aggregate tasks, so progress is derived from
    /// loaded time-ranges and cached here for `getDownloads`.
    private var progressById: [String: Float] = [:]
    /// id → completed asset location, kept RELATIVE to the home directory. The
    /// sandbox container path changes across app launches and updates, so an
    /// absolute path saved today is dangling tomorrow — Apple's documented
    /// rule for downloaded HLS assets is to persist the relative path and
    /// rebuild it against `NSHomeDirectory()` at use time.
    private var relativePathById: [String: String] = [:]
    /// id → notification strings supplied by the WebView (already localized via
    /// ngx-translate so no user-facing text is hardcoded in native).
    private var notifById: [String: (title: String, complete: String, failed: String)] = [:]

    override public func load() {
        // Restore the persisted id → relative-path map so completed downloads
        // survive an app restart.
        if let saved = UserDefaults.standard.dictionary(forKey: Self.assetsDefaultsKey) as? [String: String] {
            relativePathById = saved
            for id in saved.keys { progressById[id] = 100 }
        }

        // A background session survives app suspension AND termination. It must
        // be recreated with the SAME identifier on every launch so the OS can
        // hand back any transfers that were still running — otherwise the
        // in-flight tasks are orphaned. `.main` delegate queue keeps our
        // WebView event dispatch on the main thread.
        let config = URLSessionConfiguration.background(
            withIdentifier: BackgroundDownloadCompletion.sessionIdentifier
        )
        config.isDiscretionary = false          // start now, don't wait for wifi/charging
        config.sessionSendsLaunchEvents = true  // relaunch us to finish delivering events
        downloadSession = AVAssetDownloadURLSession(
            configuration: config,
            assetDownloadDelegate: self,
            delegateQueue: .main
        )

        // Re-adopt transfers that were still running when the app was last
        // killed so `getDownloads` reports them and progress keeps flowing.
        downloadSession.getAllTasks { [weak self] tasks in
            guard let self = self else { return }
            for task in tasks {
                guard let aggTask = task as? AVAggregateAssetDownloadTask,
                      let id = aggTask.taskDescription else { continue }
                self.activeTasks[id] = aggTask
            }
        }

        // Ask for notification permission up front so the completion banner can
        // actually appear. Silently degrades to no banner if the user declines.
        UNUserNotificationCenter.current().requestAuthorization(
            options: [.alert, .sound]
        ) { _, _ in }
    }

    // MARK: - Plugin Methods

    @objc func startDownload(_ call: CAPPluginCall) {
        guard let id = call.getString("id"),
              let hlsUrlStr = call.getString("hlsUrl"),
              let url = URL(string: hlsUrlStr) else {
            call.reject("id and a valid hlsUrl are required")
            return
        }

        // Authenticate segment + child-playlist fetches with the same bearer
        // token Android sends. The download URL already carries `?token=` for
        // the master request, but relative segment URIs derived from it may
        // not, so the header is the reliable channel. `AVURLAssetHTTPHeaderFieldsKey`
        // is applied to the asset's requests by the download task.
        var assetOptions: [String: Any] = [:]
        if let token = call.getString("token"), !token.isEmpty {
            assetOptions["AVURLAssetHTTPHeaderFieldsKey"] = ["Authorization": "Bearer \(token)"]
        }

        // Capture the (already localized) notification copy for this download.
        if let title = call.getString("notifTitle"),
           let complete = call.getString("notifComplete"),
           let failed = call.getString("notifFailed") {
            notifById[id] = (title, complete, failed)
        }

        let asset = AVURLAsset(url: url, options: assetOptions.isEmpty ? nil : assetOptions)

        // Load the media-selection groups first, then queue the download with
        // EVERY audio + subtitle rendition (not just the default preferred
        // selection). Without this only the default audio is fetched and the
        // .movpkg has no subtitles offline. The renditions land in the same
        // legible / audible selection groups NativePlayerPlugin reads online,
        // so offline subtitles/audio work with no extra wiring.
        // No `AVAssetDownloadTaskMinimumRequiredMediaBitrateKey`: the manifest
        // is already scoped to the chosen quality (startQuality in the URL), so
        // AVFoundation takes the highest variant it exposes.
        let key = "availableMediaCharacteristicsWithMediaSelectionOptions"
        asset.loadValuesAsynchronously(forKeys: [key]) { [weak self] in
            DispatchQueue.main.async {
                guard let self = self else { return }
                let selections = self.allMediaSelections(for: asset)
                guard let task = self.downloadSession.aggregateAssetDownloadTask(
                    with: asset,
                    mediaSelections: selections,
                    assetTitle: id,
                    assetArtworkData: nil,
                    options: nil
                ) else {
                    NSLog("[Download] failed to create task id=\(id)")
                    self.notifyListeners("downloadFailed", data: ["id": id, "progress": 0, "state": "failed"])
                    return
                }
                task.taskDescription = id
                self.activeTasks[id] = task
                self.progressById[id] = 0
                task.resume()
            }
        }

        // Surface the queued state immediately so the UI leaves "transcoding".
        notifyListeners("downloadProgress", data: ["id": id, "progress": 0, "state": "downloading"])
        call.resolve()
    }

    /// Every audio + subtitle media selection for the asset, each derived from
    /// the preferred selection with one option chosen in its group, so the
    /// aggregate download bakes all renditions into the .movpkg for offline use.
    private func allMediaSelections(for asset: AVURLAsset) -> [AVMediaSelection] {
        var selections: [AVMediaSelection] = []
        let base = asset.preferredMediaSelection
        for characteristic in [AVMediaCharacteristic.audible, .legible] {
            guard let group = asset.mediaSelectionGroup(forMediaCharacteristic: characteristic) else { continue }
            for option in group.options {
                guard let mutable = base.mutableCopy() as? AVMutableMediaSelection else { continue }
                mutable.select(option, in: group)
                selections.append(mutable)
            }
        }
        return selections.isEmpty ? [base] : selections
    }

    @objc func removeDownload(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("id is required")
            return
        }

        // Cancel the transfer if it is still running.
        activeTasks[id]?.cancel()
        activeTasks.removeValue(forKey: id)
        progressById.removeValue(forKey: id)
        notifById.removeValue(forKey: id)

        // Delete the on-disk bundle (resolved from the stored relative path).
        if let url = resolvedAssetURL(id: id) {
            try? FileManager.default.removeItem(at: url)
        }
        relativePathById.removeValue(forKey: id)
        persistAssetLocations()

        // Drop any lingering completion banner for this download.
        let notifId = "download-\(id)"
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [notifId])
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [notifId])

        // Mirror Android's event so the WebView reconciles its list.
        notifyListeners("downloadRemoved", data: ["id": id, "progress": 0, "state": "removed"])
        call.resolve()
    }

    @objc func getDownloads(_ call: CAPPluginCall) {
        var arr: [[String: Any]] = []

        // In-flight downloads with their last-known progress.
        for (id, _) in activeTasks {
            arr.append([
                "id": id,
                "progress": Int(progressById[id] ?? 0),
                "state": "downloading",
            ])
        }
        // Completed downloads that still exist on disk.
        for (id, _) in relativePathById where activeTasks[id] == nil {
            guard resolvedAssetURL(id: id) != nil else { continue }
            arr.append(["id": id, "progress": 100, "state": "completed"])
        }

        if let data = try? JSONSerialization.data(withJSONObject: arr),
           let json = String(data: data, encoding: .utf8) {
            call.resolve(["downloads": json])
        } else {
            call.resolve(["downloads": "[]"])
        }
    }

    @objc func isDownloaded(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.resolve(["downloaded": false])
            return
        }
        call.resolve(["downloaded": resolvedAssetURL(id: id) != nil])
    }

    /// Return the local `file://` URL for a completed offline asset so the
    /// player can load it directly. Resolved fresh from the relative path on
    /// every call, which is why it survives container-path changes.
    @objc func getOfflineUrl(_ call: CAPPluginCall) {
        guard let id = call.getString("id"),
              let url = resolvedAssetURL(id: id) else {
            call.resolve(["url": NSNull()])
            return
        }
        call.resolve(["url": url.absoluteString])
    }

    @objc func pauseDownloads(_ call: CAPPluginCall) {
        for task in activeTasks.values { task.suspend() }
        call.resolve()
    }

    @objc func resumeDownloads(_ call: CAPPluginCall) {
        for task in activeTasks.values { task.resume() }
        call.resolve()
    }

    // MARK: - AVAssetDownloadDelegate

    /// The bundle's final location, delivered before completion. Store it
    /// RELATIVE to the home directory (see `relativePathById`).
    public func urlSession(
        _ session: URLSession,
        aggregateAssetDownloadTask: AVAggregateAssetDownloadTask,
        willDownloadTo location: URL
    ) {
        guard let id = aggregateAssetDownloadTask.taskDescription else { return }
        relativePathById[id] = location.relativePath
        persistAssetLocations()
    }

    /// Progress callback — driven by loaded time-ranges, the reliable measure
    /// for HLS aggregate downloads.
    public func urlSession(
        _ session: URLSession,
        aggregateAssetDownloadTask: AVAggregateAssetDownloadTask,
        didLoad timeRange: CMTimeRange,
        totalTimeRangesLoaded: [NSValue],
        timeRangeExpectedToLoad: CMTimeRange,
        for mediaSelection: AVMediaSelection
    ) {
        guard let id = aggregateAssetDownloadTask.taskDescription else { return }
        var loadedDuration: Double = 0
        for val in totalTimeRangesLoaded {
            loadedDuration += CMTimeGetSeconds(val.timeRangeValue.duration)
        }
        let expected = CMTimeGetSeconds(timeRangeExpectedToLoad.duration)
        let progress = expected > 0 ? Float(loadedDuration / expected) * 100 : 0
        progressById[id] = progress

        notifyListeners("downloadProgress", data: [
            "id": id,
            "progress": Int(progress),
            "state": "downloading",
        ])
    }

    /// Task completion (success or failure).
    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let id = task.taskDescription else { return }
        activeTasks.removeValue(forKey: id)

        if let error = error as NSError?, error.code != NSURLErrorCancelled {
            progressById.removeValue(forKey: id)
            // A failed download leaves no usable bundle — drop its dangling
            // location so getDownloads / isDownloaded don't report it as ready.
            relativePathById.removeValue(forKey: id)
            persistAssetLocations()
            NSLog("[Download] task \(id) failed: [\(error.domain) \(error.code)] \(error.localizedDescription)")
            notifyListeners("downloadFailed", data: ["id": id, "progress": 0, "state": "failed"])
            postNotification(id: id, success: false)
        } else if error == nil {
            progressById[id] = 100
            notifyListeners("downloadComplete", data: [
                "id": id,
                "progress": 100,
                "state": "completed",
                "localUrl": resolvedAssetURL(id: id)?.absoluteString ?? "",
            ])
            postNotification(id: id, success: true)
        }
        // NSURLErrorCancelled == user-initiated removeDownload; stay silent.
    }

    /// All queued background events for the session have been delivered — tell
    /// the OS we're done so it can suspend us again (and doesn't throttle us).
    public func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        DispatchQueue.main.async {
            BackgroundDownloadCompletion.handler?()
            BackgroundDownloadCompletion.handler = nil
        }
    }

    // MARK: - Notifications

    /// Post the (pre-localized) completion or failure banner for a download.
    private func postNotification(id: String, success: Bool) {
        guard let copy = notifById[id] else { return }
        let content = UNMutableNotificationContent()
        content.title = copy.title
        content.body = success ? copy.complete : copy.failed
        content.sound = .default
        let request = UNNotificationRequest(
            identifier: "download-\(id)",
            content: content,
            trigger: nil // deliver immediately
        )
        UNUserNotificationCenter.current().add(request) { _ in }
        notifById.removeValue(forKey: id)
    }

    // MARK: - Persistence

    private func persistAssetLocations() {
        UserDefaults.standard.set(relativePathById, forKey: Self.assetsDefaultsKey)
    }

    /// Rebuild the absolute asset URL from the stored relative path and confirm
    /// the bundle still exists on disk. Returns nil if unknown or deleted.
    private func resolvedAssetURL(id: String) -> URL? {
        guard let relativePath = relativePathById[id] else { return nil }
        let baseURL = URL(fileURLWithPath: NSHomeDirectory())
        let url = baseURL.appendingPathComponent(relativePath)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    /// Local `file://` URL for an offline asset (used by NativePlayerPlugin for
    /// offline playback). Exposed for parity with the Android accessor.
    func getAssetUrl(id: String) -> URL? {
        return resolvedAssetURL(id: id)
    }
}
