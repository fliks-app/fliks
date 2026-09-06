import ActivityKit
import Capacitor
import AVFoundation
import UIKit
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
 * Transfers are capped at `maxConcurrentDownloads`; the rest wait in `pending`
 * and report as `queued`. An auto-download playlist can enqueue a dozen items
 * in one pass, and a dozen concurrent HLS transfers just thrash the network and
 * the disk without finishing any of them sooner.
 *
 *   methods  startDownload / removeDownload / getDownloads / isDownloaded
 *            / getOfflineUrl / pauseDownloads / resumeDownloads
 *            / setActivityCopy
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
        CAPPluginMethod(name: "setActivityCopy", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setMaxConcurrentDownloads", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "dismissActivity", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDownloadSize", returnType: CAPPluginReturnPromise),
    ]

    /// Concurrent transfers. HLS aggregate downloads are segment-chatty, so a
    /// wide queue slows every item down instead of finishing any of them. The
    /// WebView pushes the user's setting over `setMaxConcurrentDownloads`; this
    /// is only the value in force until it does.
    private var maxConcurrentDownloads = 3

    /// UserDefaults key under which the id → relative-path map is persisted.
    private static let assetsDefaultsKey = "fliks_offline_assets"
    /// UserDefaults key for the ids whose transfer actually finished.
    private static let completedDefaultsKey = "fliks_offline_completed"

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
    /// Ids whose transfer finished. A path in `relativePathById` only says
    /// where the bundle WILL land — AVFoundation hands it over up front, and
    /// the partial `.movpkg` exists on disk from the first segment — so the
    /// path alone can't answer "is this downloaded".
    private var completedIds: Set<String> = []
    /// id → notification strings supplied by the WebView (already localized via
    /// ngx-translate so no user-facing text is hardcoded in native).
    private var notifById: [String: NotifCopy] = [:]
    /// Requests waiting for a free slot, oldest first.
    private var pending: [PendingDownload] = []
    /// Ids whose task is still being created. The asset load is async, so they
    /// hold a slot before they ever reach `activeTasks`.
    private var starting: Set<String> = []
    /// Set by `pauseDownloads`, so a finishing task doesn't pull the next
    /// request out of the queue behind the user's back.
    private var paused = false

    /// The queue's Live Activity — one for the whole batch, not one per item.
    private var activity: Activity<DownloadActivityAttributes>?
    /// Overall percentage last pushed. ActivityKit budgets updates and the
    /// delegate fires far more often than the bar can visibly move, so pushes
    /// are coalesced to whole points.
    private var activityPercent = -1
    /// Copy for the activity, supplied by the WebView (see `setActivityCopy`).
    private var activityCopy: ActivityCopy?

    /// Downloads the running activity covers, and how many have stopped. Reset
    /// once the queue drains, which is also when the activity ends.
    private var batchTotal = 0
    private var batchDone = 0
    private var batchFailed = 0

    /// How long a published state stays believable. Without push updates the
    /// app can't refresh a suspended queue, so past this the card labels itself
    /// out of date instead of presenting a frozen percentage as live.
    private static let activityStaleAfter: TimeInterval = 180

    struct NotifCopy {
        let title: String
        let progress: String
        let stale: String
        let complete: String
        let failed: String
    }

    struct ActivityCopy {
        var headline: String
        var detail: String
        var stale: String
        var complete: String
        var failed: String
    }

    struct PendingDownload {
        let id: String
        let url: URL
        let assetOptions: [String: Any]
    }

    override public func load() {
        // Restore the persisted id → relative-path map so completed downloads
        // survive an app restart.
        if let saved = UserDefaults.standard.dictionary(forKey: Self.assetsDefaultsKey) as? [String: String] {
            relativePathById = saved
            // Installs that predate the completed set only ever persisted paths
            // for downloads they reported as done — adopt them as such.
            completedIds = Set(
                UserDefaults.standard.array(forKey: Self.completedDefaultsKey) as? [String]
                    ?? Array(saved.keys)
            )
            for id in completedIds { progressById[id] = 100 }
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

        reclaimOrphanActivities()

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
            notifById[id] = NotifCopy(
                title: title,
                progress: call.getString("notifProgress") ?? complete,
                stale: call.getString("notifStale") ?? complete,
                complete: complete,
                failed: failed
            )
        }

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.pending.append(PendingDownload(id: id, url: url, assetOptions: assetOptions))
            self.batchTotal += 1
            self.seedActivityCopy(from: id)
            self.startActivityIfNeeded()
            // Surface the state immediately so the UI leaves "transcoding" —
            // queued when it has to wait its turn, downloading when it doesn't.
            let willStart = self.inFlightCount < self.maxConcurrentDownloads && !self.paused
            self.notifyListeners("downloadProgress", data: [
                "id": id,
                "progress": 0,
                "state": willStart ? "downloading" : "queued",
            ])
            self.pumpQueue()
        }
        call.resolve()
    }

    // MARK: - Queue

    private var inFlightCount: Int { activeTasks.count + starting.count }

    /// Start as many queued downloads as the concurrency cap allows.
    private func pumpQueue() {
        guard !paused else { return }
        while inFlightCount < maxConcurrentDownloads, !pending.isEmpty {
            beginDownload(pending.removeFirst())
        }
    }

    /// Create and resume one transfer.
    ///
    /// Loading the media-selection groups needs a round-trip to the master
    /// playlist, and the transfer only becomes the background session's
    /// business once the task is resumed. A background assertion covers that
    /// gap, so backgrounding the app right after tapping Download can't suspend
    /// us in between and lose the download before it starts.
    private func beginDownload(_ request: PendingDownload) {
        let id = request.id
        starting.insert(id)

        let asset = AVURLAsset(
            url: request.url,
            options: request.assetOptions.isEmpty ? nil : request.assetOptions
        )

        var assertion = UIBackgroundTaskIdentifier.invalid
        assertion = UIApplication.shared.beginBackgroundTask(withName: "fliks.download.start") {
            UIApplication.shared.endBackgroundTask(assertion)
            assertion = .invalid
        }
        let release = {
            guard assertion != .invalid else { return }
            UIApplication.shared.endBackgroundTask(assertion)
            assertion = .invalid
        }

        // Download EVERY audio + subtitle rendition, not just the default
        // preferred selection: without this only the default audio is fetched
        // and the .movpkg has no subtitles offline. The renditions land in the
        // same legible / audible selection groups NativePlayerPlugin reads
        // online, so offline subtitles/audio work with no extra wiring.
        // No `AVAssetDownloadTaskMinimumRequiredMediaBitrateKey`: the manifest
        // is already scoped to the chosen quality (startQuality in the URL), so
        // AVFoundation takes the highest variant it exposes.
        Task { @MainActor [weak self] in
            defer { release() }
            guard let self = self else { return }
            let selections = await self.allMediaSelections(for: asset)
            // `removeDownload` drops the id from `starting`; if it is gone
            // the user cancelled while the asset was loading.
            guard self.starting.remove(id) != nil else { return }
            guard let task = self.downloadSession.aggregateAssetDownloadTask(
                with: asset,
                mediaSelections: selections,
                assetTitle: id,
                assetArtworkData: nil,
                options: nil
            ) else {
                NSLog("[Download] failed to create task id=\(id)")
                self.notifyListeners("downloadFailed", data: ["id": id, "progress": 0, "state": "failed"])
                self.batchFailed += 1
                self.finishBatchItem()
                self.pumpQueue()
                return
            }
            task.taskDescription = id
            self.activeTasks[id] = task
            self.progressById[id] = 0
            task.resume()
            self.notifyListeners("downloadProgress", data: [
                "id": id, "progress": 0, "state": "downloading",
            ])
        }
    }

    /// Every audio + subtitle media selection for the asset, each derived from
    /// the preferred selection with one option chosen in its group, so the
    /// aggregate download bakes all renditions into the .movpkg for offline use.
    private func allMediaSelections(for asset: AVURLAsset) async -> [AVMediaSelection] {
        guard let base = try? await asset.load(.preferredMediaSelection) else { return [] }
        var selections: [AVMediaSelection] = []
        for characteristic in [AVMediaCharacteristic.audible, .legible] {
            guard let group = try? await asset.loadMediaSelectionGroup(for: characteristic) else { continue }
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

        // Cancel the transfer wherever it currently sits — running, still
        // being created, or waiting its turn.
        let wasTracked = activeTasks[id] != nil
            || starting.contains(id)
            || pending.contains { $0.id == id }
        activeTasks[id]?.cancel()
        activeTasks.removeValue(forKey: id)
        starting.remove(id)
        pending.removeAll { $0.id == id }
        progressById.removeValue(forKey: id)
        completedIds.remove(id)
        notifById.removeValue(forKey: id)
        if wasTracked { dropFromBatch() }

        // Delete the on-disk bundle (resolved from the stored relative path).
        if let url = resolvedAssetURL(id: id) {
            try? FileManager.default.removeItem(at: url)
        }
        relativePathById.removeValue(forKey: id)
        persistAssetState()

        // Drop any lingering completion banner for this download.
        let notifId = "download-\(id)"
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [notifId])
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [notifId])

        // Mirror Android's event so the WebView reconciles its list.
        notifyListeners("downloadRemoved", data: ["id": id, "progress": 0, "state": "removed"])
        pumpQueue()
        call.resolve()
    }

    /// Ask the session for its tasks rather than reading `activeTasks`: that map
    /// is repopulated asynchronously in `load()`, and a call landing inside that
    /// window would report a live transfer as gone — the WebView then fails the
    /// download and cancels a perfectly healthy background task.
    @objc func getDownloads(_ call: CAPPluginCall) {
        downloadSession.getAllTasks { [weak self] tasks in
            guard let self = self else {
                call.resolve(["downloads": "[]"])
                return
            }

            var arr: [[String: Any]] = []
            var live: [String: AVAggregateAssetDownloadTask] = [:]
            for task in tasks {
                guard let aggTask = task as? AVAggregateAssetDownloadTask,
                      let id = aggTask.taskDescription else { continue }
                live[id] = aggTask
                arr.append([
                    "id": id,
                    "progress": Int(self.progressById[id] ?? 0),
                    "state": "downloading",
                ])
            }
            self.activeTasks = live

            // Tasks the session hasn't been handed yet, and requests still
            // waiting for a slot. Neither is in `getAllTasks`, and reporting
            // them as gone makes the WebView fail a healthy download.
            for id in self.starting where live[id] == nil {
                arr.append(["id": id, "progress": 0, "state": "downloading"])
            }
            for request in self.pending {
                arr.append(["id": request.id, "progress": 0, "state": "queued"])
            }

            // Completed downloads that still exist on disk.
            for id in self.completedIds where live[id] == nil {
                guard self.resolvedAssetURL(id: id) != nil else { continue }
                arr.append(["id": id, "progress": 100, "state": "completed"])
            }

            if let data = try? JSONSerialization.data(withJSONObject: arr),
               let json = String(data: data, encoding: .utf8) {
                call.resolve(["downloads": json])
            } else {
                call.resolve(["downloads": "[]"])
            }
        }
    }

    @objc func isDownloaded(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.resolve(["downloaded": false])
            return
        }
        call.resolve(["downloaded": completedIds.contains(id) && resolvedAssetURL(id: id) != nil])
    }

    /// Bytes the download occupies on disk. Zero when it isn't there.
    @objc func getDownloadSize(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.resolve(["bytes": 0])
            return
        }
        // `relativePathById` is main-thread state; the walk that follows is not
        // something to run there — a film's bundle is thousands of segments.
        DispatchQueue.main.async { [weak self] in
            guard let url = self?.resolvedAssetURL(id: id) else {
                call.resolve(["bytes": 0])
                return
            }
            DispatchQueue.global(qos: .utility).async {
                call.resolve(["bytes": Self.bundleSize(at: url)])
            }
        }
    }

    /// Allocated size of a downloaded asset, walked recursively: a `.movpkg` is
    /// a directory, so asking the file system about it directly reports the
    /// folder entry rather than the media inside it.
    private static func bundleSize(at url: URL) -> Int {
        let keys: Set<URLResourceKey> = [
            .isRegularFileKey, .totalFileAllocatedSizeKey, .fileAllocatedSizeKey,
        ]
        guard let walker = FileManager.default.enumerator(
            at: url, includingPropertiesForKeys: Array(keys)
        ) else { return 0 }

        var total = 0
        for case let file as URL in walker {
            guard let values = try? file.resourceValues(forKeys: keys),
                  values.isRegularFile == true else { continue }
            total += values.totalFileAllocatedSize ?? values.fileAllocatedSize ?? 0
        }
        return total
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
        paused = true
        for task in activeTasks.values { task.suspend() }
        call.resolve()
    }

    @objc func resumeDownloads(_ call: CAPPluginCall) {
        paused = false
        for task in activeTasks.values { task.resume() }
        pumpQueue()
        call.resolve()
    }

    /// Cap concurrent transfers. Raising it starts queued downloads at once;
    /// lowering it lets the extra ones finish rather than cancelling work
    /// already paid for, and the queue narrows as they drain.
    @objc func setMaxConcurrentDownloads(_ call: CAPPluginCall) {
        let requested = call.getInt("max") ?? maxConcurrentDownloads
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.maxConcurrentDownloads = max(1, min(5, requested))
            self.pumpQueue()
        }
        call.resolve()
    }

    /// Retire the queue's Live Activity, whatever state this process thinks it
    /// is in. The WebView calls it once nothing is downloading any more — after
    /// a force-quit that is the only reliable moment, since no code runs at
    /// termination and `Activity.activities` can still be empty when the plugin
    /// loads.
    @objc func dismissActivity(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.retireAllActivities()
        }
        call.resolve()
    }

    /// Copy for the queue's Live Activity. The WebView owns it: it holds the
    /// translations and knows whether to name a title or count the batch.
    @objc func setActivityCopy(_ call: CAPPluginCall) {
        guard let headline = call.getString("headline"),
              let detail = call.getString("detail") else {
            call.resolve()
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.activityCopy = ActivityCopy(
                headline: headline,
                detail: detail,
                stale: call.getString("stale") ?? self.activityCopy?.stale ?? detail,
                complete: call.getString("complete") ?? self.activityCopy?.complete ?? "",
                failed: call.getString("failed") ?? self.activityCopy?.failed ?? ""
            )
            self.pushActivityState(force: true)
        }
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
        persistAssetState()
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

        pushActivityState()

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
            // A failed download leaves a partial bundle behind. Delete it and
            // drop its location so nothing reports it as ready or plays it.
            if let partial = resolvedAssetURL(id: id) {
                try? FileManager.default.removeItem(at: partial)
            }
            relativePathById.removeValue(forKey: id)
            completedIds.remove(id)
            persistAssetState()
            NSLog("[Download] task \(id) failed: [\(error.domain) \(error.code)] \(error.localizedDescription)")
            notifyListeners("downloadFailed", data: ["id": id, "progress": 0, "state": "failed"])
            postNotification(id: id, success: false)
            batchFailed += 1
            finishBatchItem()
            pumpQueue()
        } else if error == nil {
            progressById[id] = 100
            completedIds.insert(id)
            persistAssetState()
            notifyListeners("downloadComplete", data: [
                "id": id,
                "progress": 100,
                "state": "completed",
                "localUrl": resolvedAssetURL(id: id)?.absoluteString ?? "",
            ])
            postNotification(id: id, success: true)
            finishBatchItem()
            pumpQueue()
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

    // MARK: - Live Activity

    /// Deal with a Live Activity left over from a previous run.
    ///
    /// The system owns a running activity, not us: it outlives the process, and
    /// nothing runs at force-quit to retire it (`applicationWillTerminate` is
    /// not called when the app is swiped away). So the card can still be on the
    /// Lock Screen at launch, and without this the next download would publish a
    /// second one beside it.
    ///
    /// A transfer the session still holds means the card is legitimate and gets
    /// adopted, batch counters included. Otherwise the queue it described is
    /// gone — force-quit cancels background transfers — and it is retired.
    private func reclaimOrphanActivities() {
        let orphans = Activity<DownloadActivityAttributes>.activities
        guard !orphans.isEmpty else { return }

        downloadSession.getAllTasks { [weak self] tasks in
            guard let self = self else { return }
            let liveIds = tasks.compactMap { ($0 as? AVAggregateAssetDownloadTask)?.taskDescription }
            guard !liveIds.isEmpty, let adopted = orphans.first else {
                for activity in orphans {
                    Task { await activity.end(nil, dismissalPolicy: .immediate) }
                }
                return
            }
            // Keep one, retire any extras, and let the running state carry it
            // until the WebView pushes fresh copy.
            self.activity = adopted
            // Re-seed the batch from what survived, or the first push would
            // report 0% and the first completion would retire the card.
            self.batchTotal = max(self.batchTotal, liveIds.count)
            self.activityCopy = ActivityCopy(
                headline: adopted.content.state.headline,
                detail: adopted.content.state.detail,
                stale: adopted.content.state.stale,
                complete: adopted.content.state.detail,
                failed: adopted.content.state.detail
            )
            self.activityPercent = -1
            for extra in orphans.dropFirst() {
                Task { await extra.end(nil, dismissalPolicy: .immediate) }
            }
        }
    }

    /// Fall back to the first download's banner copy so the card is right from
    /// the first frame. The WebView replaces it via `setActivityCopy` as soon as
    /// it has recomputed the batch, which is the only place that knows whether
    /// to name a title or count the queue.
    private func seedActivityCopy(from id: String) {
        guard activityCopy == nil, let copy = notifById[id] else { return }
        activityCopy = ActivityCopy(
            headline: copy.title,
            detail: copy.progress,
            stale: copy.stale,
            complete: copy.complete,
            failed: copy.failed
        )
    }

    /// Publish the queue's Live Activity — a lock-screen card and, on the models
    /// that have one, the Dynamic Island. Silently skipped when the user has
    /// Live Activities turned off, which is the documented failure mode.
    private func startActivityIfNeeded() {
        guard activity == nil,
              ActivityAuthorizationInfo().areActivitiesEnabled,
              let copy = activityCopy else { return }
        do {
            activity = try Activity.request(
                attributes: DownloadActivityAttributes(),
                content: .init(state: currentState(with: copy), staleDate: nextStaleDate())
            )
            activityPercent = 0
        } catch {
            NSLog("[Download] Live Activity refused: \(error.localizedDescription)")
        }
    }

    /// End every activity this app owns, adopted or not, and reset the batch.
    /// Sweeping the system's list rather than just `activity` is what clears a
    /// card left behind by a previous run that this process never adopted.
    private func retireAllActivities() {
        activity = nil
        activityCopy = nil
        activityPercent = -1
        batchTotal = 0
        batchDone = 0
        batchFailed = 0
        for orphan in Activity<DownloadActivityAttributes>.activities {
            Task { await orphan.end(nil, dismissalPolicy: .immediate) }
        }
    }

    private func nextStaleDate() -> Date {
        Date().addingTimeInterval(Self.activityStaleAfter)
    }

    /// Progress across the whole batch, finished items counted as complete.
    private func overallProgress() -> Double {
        guard batchTotal > 0 else { return 0 }
        let live = activeTasks.keys.reduce(0.0) { $0 + Double(progressById[$1] ?? 0) }
        return min(1, (Double(batchDone) * 100 + live) / (Double(batchTotal) * 100))
    }

    private func currentState(
        with copy: ActivityCopy
    ) -> DownloadActivityAttributes.ContentState {
        .init(
            progress: overallProgress(),
            remaining: max(0, batchTotal - batchDone),
            headline: copy.headline,
            detail: copy.detail,
            stale: copy.stale,
            finished: false
        )
    }

    /// Push the batch's state, coalesced to whole percentage points unless the
    /// caller changed something else (`force`).
    private func pushActivityState(force: Bool = false) {
        guard let activity, let copy = activityCopy else { return }
        let percent = Int(overallProgress() * 100)
        guard force || percent != activityPercent else { return }
        activityPercent = percent
        let state = currentState(with: copy)
        Task { await activity.update(.init(state: state, staleDate: nextStaleDate())) }
    }

    /// One download stopped, for any reason. When that empties the queue the
    /// activity reports the outcome and retires.
    private func finishBatchItem() {
        batchDone += 1
        settleBatch()
    }

    /// A download left the batch entirely (the user deleted it), so it should
    /// not count towards the total either.
    private func dropFromBatch() {
        batchTotal = max(0, batchTotal - 1)
        settleBatch()
    }

    private func settleBatch() {
        guard activeTasks.isEmpty, starting.isEmpty, pending.isEmpty else {
            pushActivityState(force: true)
            return
        }
        let finished = batchTotal > 0 && batchDone > 0
        endActivity(outcome: finished ? (batchFailed > 0 ? .failed : .complete) : .abandoned)
        batchTotal = 0
        batchDone = 0
        batchFailed = 0
    }

    private enum BatchOutcome { case complete, failed, abandoned }

    /// Show the outcome briefly, then let the system retire the card. Nothing
    /// finished (the user cleared the queue) retires it at once instead.
    private func endActivity(outcome: BatchOutcome) {
        let current = activity
        let copy = activityCopy
        activity = nil
        activityCopy = nil
        activityPercent = -1
        // No outcome worth showing, or nothing of ours to show it on — sweep
        // instead of returning, or a card this process never adopted survives.
        guard outcome != .abandoned, let current, let copy else {
            retireAllActivities()
            return
        }
        // Anything else on screen predates this batch and has no outcome due.
        for stray in Activity<DownloadActivityAttributes>.activities where stray.id != current.id {
            Task { await stray.end(nil, dismissalPolicy: .immediate) }
        }
        let state = DownloadActivityAttributes.ContentState(
            progress: outcome == .complete ? 1 : overallProgress(),
            remaining: 0,
            headline: copy.headline,
            detail: outcome == .complete ? copy.complete : copy.failed,
            stale: copy.stale,
            finished: true
        )
        Task {
            await current.end(
                .init(state: state, staleDate: nil),
                dismissalPolicy: .after(.now + 5)
            )
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

    private func persistAssetState() {
        UserDefaults.standard.set(relativePathById, forKey: Self.assetsDefaultsKey)
        UserDefaults.standard.set(Array(completedIds), forKey: Self.completedDefaultsKey)
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
