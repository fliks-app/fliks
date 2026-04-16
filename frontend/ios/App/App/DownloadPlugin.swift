import Capacitor
import AVFoundation

/**
 * Capacitor plugin for offline HLS downloads on iOS.
 * Uses AVAssetDownloadURLSession to download HLS content as .movpkg
 * bundles that AVPlayer can play natively offline.
 */
@objc(DownloadNotification)
class DownloadPlugin: CAPPlugin, CAPBridgedPlugin, AVAssetDownloadDelegate {
    let identifier = "DownloadNotification"
    let jsName = "DownloadNotification"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startDownload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeDownload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDownloads", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isDownloaded", returnType: CAPPluginReturnPromise),
    ]

    private var downloadSession: AVAssetDownloadURLSession!
    /// Maps taskDescription (our download ID) → active download task
    private var activeTasks: [String: AVAggregateAssetDownloadTask] = [:]
    /// Maps taskDescription → local .movpkg URL (set on completion)
    private var downloadedAssets: [String: URL] = [:]

    override func load() {
        // Restore persisted asset locations
        if let saved = UserDefaults.standard.dictionary(forKey: "fliks_offline_assets") as? [String: String] {
            for (id, path) in saved {
                downloadedAssets[id] = URL(fileURLWithPath: path)
            }
        }

        // Background session survives app suspension
        let config = URLSessionConfiguration.background(withIdentifier: "com.fliks.download")
        downloadSession = AVAssetDownloadURLSession(
            configuration: config,
            assetDownloadDelegate: self,
            delegateQueue: .main
        )
    }

    // MARK: - Plugin Methods

    @objc func startDownload(_ call: CAPPluginCall) {
        guard let id = call.getString("id"),
              let hlsUrlStr = call.getString("hlsUrl") else {
            call.reject("id and hlsUrl are required")
            return
        }

        // Add auth token to the URL (AVAssetDownloadTask doesn't support custom headers)
        var urlStr = hlsUrlStr
        if let token = call.getString("token"), !token.isEmpty {
            let sep = urlStr.contains("?") ? "&" : "?"
            urlStr += "\(sep)token=\(token)"
        }

        guard let url = URL(string: urlStr) else {
            call.reject("Invalid URL")
            return
        }

        let asset = AVURLAsset(url: url)
        guard let task = downloadSession.aggregateAssetDownloadTask(
            with: asset,
            mediaSelections: [asset.preferredMediaSelection],
            assetTitle: id,
            assetArtworkData: nil,
            options: [AVAssetDownloadTaskMinimumRequiredMediaBitrateKey: 0]
        ) else {
            call.reject("Failed to create download task")
            return
        }

        task.taskDescription = id
        activeTasks[id] = task
        task.resume()

        call.resolve()
    }

    @objc func removeDownload(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("id is required")
            return
        }

        // Cancel active task if running
        activeTasks[id]?.cancel()
        activeTasks.removeValue(forKey: id)

        // Delete downloaded asset
        if let url = downloadedAssets[id] {
            try? FileManager.default.removeItem(at: url)
            downloadedAssets.removeValue(forKey: id)
            persistAssetLocations()
        }

        call.resolve()
    }

    @objc func getDownloads(_ call: CAPPluginCall) {
        var arr: [[String: Any]] = []

        // Active downloads
        for (id, task) in activeTasks {
            arr.append([
                "id": id,
                "progress": task.countOfBytesReceived > 0 && task.countOfBytesExpectedToReceive > 0
                    ? Float(task.countOfBytesReceived) / Float(task.countOfBytesExpectedToReceive) * 100
                    : 0,
                "state": "downloading",
            ])
        }

        // Completed downloads
        for (id, _) in downloadedAssets where activeTasks[id] == nil {
            arr.append([
                "id": id,
                "progress": 100,
                "state": "completed",
            ])
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
        let exists = downloadedAssets[id] != nil
            && FileManager.default.fileExists(atPath: downloadedAssets[id]!.path)
        call.resolve(["downloaded": exists])
    }

    // MARK: - AVAssetDownloadDelegate

    /// Called when all media selections for a task have been downloaded
    func urlSession(
        _ session: URLSession,
        aggregateAssetDownloadTask: AVAggregateAssetDownloadTask,
        willDownloadTo location: URL
    ) {
        guard let id = aggregateAssetDownloadTask.taskDescription else { return }
        downloadedAssets[id] = location
        persistAssetLocations()
    }

    /// Progress callback
    func urlSession(
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

        notifyListeners("downloadProgress", data: [
            "id": id,
            "progress": progress,
            "state": "downloading",
        ])
    }

    /// Task completion (success or failure)
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let id = task.taskDescription else { return }
        activeTasks.removeValue(forKey: id)

        if let error = error as NSError?, error.code != NSURLErrorCancelled {
            notifyListeners("downloadFailed", data: [
                "id": id,
                "progress": 0,
                "state": "failed",
            ])
        } else if error == nil {
            notifyListeners("downloadComplete", data: [
                "id": id,
                "progress": 100,
                "state": "completed",
            ])
        }
    }

    // MARK: - Persistence

    /// Save .movpkg locations to UserDefaults so they survive app restart
    private func persistAssetLocations() {
        var dict: [String: String] = [:]
        for (id, url) in downloadedAssets {
            dict[id] = url.path
        }
        UserDefaults.standard.set(dict, forKey: "fliks_offline_assets")
    }

    /// Get the local file:// URL for an offline asset (used for playback)
    func getAssetUrl(id: String) -> URL? {
        guard let url = downloadedAssets[id],
              FileManager.default.fileExists(atPath: url.path) else { return nil }
        return url
    }
}
