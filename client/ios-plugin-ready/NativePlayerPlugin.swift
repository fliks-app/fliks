import Foundation
import Capacitor
import AVFoundation
import AVKit

/**
 * Capacitor plugin wrapping AVPlayer for native HLS playback on iOS.
 * Renders behind the WKWebView — the Angular UI overlays on top.
 *
 * After running `npx cap add ios`, copy this file to:
 *   ios/App/App/NativePlayerPlugin.swift
 *
 * Then register in AppDelegate or via Capacitor plugin loader.
 */
@objc(NativePlayerPlugin)
public class NativePlayerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativePlayerPlugin"
    public let jsName = "NativePlayer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "create", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "destroy", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "load", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seek", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getAudioTracks", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "selectAudioTrack", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSubtitleTracks", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "selectSubtitleTrack", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "addExternalSubtitle", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPosition", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPlaybackRate", returnType: CAPPluginReturnPromise),
    ]

    private var player: AVPlayer?
    private var playerLayer: AVPlayerLayer?
    private var playerView: UIView?
    private var timeObserver: Any?
    private var statusObserver: NSKeyValueObservation?
    private var rateObserver: NSKeyValueObservation?

    // MARK: - Lifecycle

    @objc func create(_ call: CAPPluginCall) {
        let x = call.getInt("x") ?? 0
        let y = call.getInt("y") ?? 0
        let width = call.getInt("width") ?? Int(UIScreen.main.bounds.width)
        let height = call.getInt("height") ?? Int(UIScreen.main.bounds.height)

        DispatchQueue.main.async { [weak self] in
            guard let self = self, let webView = self.bridge?.webView else {
                call.reject("Bridge not available")
                return
            }

            // Create a view for the player layer
            let view = UIView(frame: CGRect(
                x: CGFloat(x),
                y: CGFloat(y),
                width: CGFloat(width),
                height: CGFloat(height)
            ))
            view.backgroundColor = .black

            // Insert BEHIND the WebView
            webView.superview?.insertSubview(view, belowSubview: webView)

            // Make WebView transparent
            webView.isOpaque = false
            webView.backgroundColor = .clear
            webView.scrollView.backgroundColor = .clear

            self.playerView = view
            call.resolve()
        }
    }

    @objc func destroy(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.cleanup()
            call.resolve()
        }
    }

    @objc func resize(_ call: CAPPluginCall) {
        let x = call.getInt("x") ?? 0
        let y = call.getInt("y") ?? 0
        let width = call.getInt("width") ?? 0
        let height = call.getInt("height") ?? 0

        DispatchQueue.main.async { [weak self] in
            self?.playerView?.frame = CGRect(
                x: CGFloat(x),
                y: CGFloat(y),
                width: CGFloat(width),
                height: CGFloat(height)
            )
            self?.playerLayer?.frame = self?.playerView?.bounds ?? .zero
            call.resolve()
        }
    }

    // MARK: - Playback

    @objc func load(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"),
              let url = URL(string: urlString) else {
            call.reject("URL is required")
            return
        }

        let startTime = call.getDouble("startTime") ?? 0
        let headers = call.getObject("headers") ?? [:]

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }

            // Clean up previous player
            self.removeObservers()
            self.player?.pause()

            // Create AVURLAsset with custom headers
            var assetHeaders: [String: String] = [:]
            for (key, value) in headers {
                if let str = value as? String {
                    assetHeaders[key] = str
                }
            }

            let asset = AVURLAsset(url: url, options: assetHeaders.isEmpty ? nil : [
                "AVURLAssetHTTPHeaderFieldsKey": assetHeaders,
            ])

            let playerItem = AVPlayerItem(asset: asset)
            let player = AVPlayer(playerItem: playerItem)
            self.player = player

            // Setup player layer
            if self.playerLayer == nil, let view = self.playerView {
                let layer = AVPlayerLayer(player: player)
                layer.frame = view.bounds
                layer.videoGravity = .resizeAspect
                view.layer.addSublayer(layer)
                self.playerLayer = layer
            } else {
                self.playerLayer?.player = player
            }

            // Observe playback state
            self.setupObservers()

            // Seek to start position
            if startTime > 0 {
                let cmTime = CMTime(seconds: startTime, preferredTimescale: 1000)
                player.seek(to: cmTime) { _ in
                    player.play()
                }
            } else {
                player.play()
            }

            call.resolve()
        }
    }

    @objc func play(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.player?.play()
            call.resolve()
        }
    }

    @objc func pause(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.player?.pause()
            call.resolve()
        }
    }

    @objc func seek(_ call: CAPPluginCall) {
        let position = call.getDouble("position") ?? 0
        DispatchQueue.main.async { [weak self] in
            let cmTime = CMTime(seconds: position, preferredTimescale: 1000)
            self?.player?.seek(to: cmTime, toleranceBefore: .zero, toleranceAfter: .zero)
            call.resolve()
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.player?.pause()
            self?.player?.replaceCurrentItem(with: nil)
            call.resolve()
        }
    }

    // MARK: - Audio Tracks

    @objc func getAudioTracks(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            var tracks: [[String: Any]] = []

            if let item = self?.player?.currentItem,
               let group = item.asset.mediaSelectionGroup(forMediaCharacteristic: .audible) {
                for (index, option) in group.options.enumerated() {
                    let locale = option.locale ?? Locale(identifier: "und")
                    tracks.append([
                        "id": "audio-\(index)",
                        "language": locale.languageCode ?? "und",
                        "label": option.displayName,
                    ])
                }
            }

            call.resolve(["tracks": tracks])
        }
    }

    @objc func selectAudioTrack(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("id is required")
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard let item = self?.player?.currentItem,
                  let group = item.asset.mediaSelectionGroup(forMediaCharacteristic: .audible) else {
                call.reject("No audio tracks available")
                return
            }

            let index = Int(id.replacingOccurrences(of: "audio-", with: "")) ?? 0
            guard index < group.options.count else {
                call.reject("Invalid track id")
                return
            }

            // Seamless audio switch — no reload needed
            item.select(group.options[index], in: group)
            call.resolve()
        }
    }

    // MARK: - Subtitle Tracks

    @objc func getSubtitleTracks(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            var tracks: [[String: Any]] = []

            if let item = self?.player?.currentItem,
               let group = item.asset.mediaSelectionGroup(forMediaCharacteristic: .legible) {
                for (index, option) in group.options.enumerated() {
                    let locale = option.locale ?? Locale(identifier: "und")
                    tracks.append([
                        "id": "text-\(index)",
                        "language": locale.languageCode ?? "und",
                        "label": option.displayName,
                    ])
                }
            }

            call.resolve(["tracks": tracks])
        }
    }

    @objc func selectSubtitleTrack(_ call: CAPPluginCall) {
        let id = call.getString("id")

        DispatchQueue.main.async { [weak self] in
            guard let item = self?.player?.currentItem,
                  let group = item.asset.mediaSelectionGroup(forMediaCharacteristic: .legible) else {
                call.resolve()
                return
            }

            if let id = id {
                let index = Int(id.replacingOccurrences(of: "text-", with: "")) ?? 0
                if index < group.options.count {
                    item.select(group.options[index], in: group)
                }
            } else {
                // Disable subtitles
                item.select(nil, in: group)
            }

            call.resolve()
        }
    }

    @objc func addExternalSubtitle(_ call: CAPPluginCall) {
        // External subtitle support via AVPlayer requires AVMutableComposition.
        // For now, return a stub ID — the frontend can handle subtitle display.
        let id = "ext-sub-\(Int(Date().timeIntervalSince1970 * 1000))"
        call.resolve(["id": id])
    }

    // MARK: - State

    @objc func getPosition(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            let pos = self?.player?.currentTime().seconds ?? 0
            let dur = self?.player?.currentItem?.duration.seconds ?? 0
            let buffered = self?.getBufferedPosition() ?? 0

            call.resolve([
                "position": pos.isFinite ? pos : 0,
                "duration": dur.isFinite ? dur : 0,
                "buffered": buffered,
            ])
        }
    }

    @objc func setPlaybackRate(_ call: CAPPluginCall) {
        let rate = call.getFloat("rate") ?? 1.0
        DispatchQueue.main.async { [weak self] in
            self?.player?.rate = rate
            call.resolve()
        }
    }

    // MARK: - Private

    private func setupObservers() {
        guard let player = player else { return }

        // Periodic time observer (every second)
        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 1, preferredTimescale: 1000),
            queue: .main
        ) { [weak self] time in
            self?.emitTimeUpdate()
        }

        // Playback status
        statusObserver = player.currentItem?.observe(\.status) { [weak self] item, _ in
            switch item.status {
            case .readyToPlay:
                self?.emitStateChanged("playing")
                self?.emitTracksChanged()
            case .failed:
                let msg = item.error?.localizedDescription ?? "Playback failed"
                self?.emitError(code: -1, message: msg)
            default:
                break
            }
        }

        // Rate changes (play/pause detection)
        rateObserver = player.observe(\.rate) { [weak self] player, _ in
            if player.rate == 0 {
                self?.emitStateChanged("paused")
            } else {
                self?.emitStateChanged("playing")
            }
        }

        // Buffering detection
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(playerStalled),
            name: .AVPlayerItemPlaybackStalled,
            object: player.currentItem
        )
    }

    @objc private func playerStalled() {
        emitStateChanged("buffering")
    }

    private func removeObservers() {
        if let obs = timeObserver {
            player?.removeTimeObserver(obs)
            timeObserver = nil
        }
        statusObserver?.invalidate()
        statusObserver = nil
        rateObserver?.invalidate()
        rateObserver = nil
        NotificationCenter.default.removeObserver(self)
    }

    private func cleanup() {
        removeObservers()
        player?.pause()
        player = nil
        playerLayer?.removeFromSuperlayer()
        playerLayer = nil
        playerView?.removeFromSuperview()
        playerView = nil
    }

    private func getBufferedPosition() -> Double {
        guard let ranges = player?.currentItem?.loadedTimeRanges else { return 0 }
        if let range = ranges.last?.timeRangeValue {
            let end = CMTimeGetSeconds(range.start) + CMTimeGetSeconds(range.duration)
            return end.isFinite ? end : 0
        }
        return 0
    }

    // MARK: - Event Emitters

    private func emitStateChanged(_ state: String) {
        let js = "window.dispatchEvent(new CustomEvent('nativePlayerStateChanged', { detail: { state: '\(state)' } }));"
        DispatchQueue.main.async { [weak self] in
            self?.bridge?.webView?.evaluateJavaScript(js)
        }
    }

    private func emitTimeUpdate() {
        let pos = player?.currentTime().seconds ?? 0
        let dur = player?.currentItem?.duration.seconds ?? 0
        let buf = getBufferedPosition()

        let js = "window.dispatchEvent(new CustomEvent('nativePlayerTimeUpdate', { detail: { position: \(pos.isFinite ? pos : 0), duration: \(dur.isFinite ? dur : 0), buffered: \(buf) } }));"
        DispatchQueue.main.async { [weak self] in
            self?.bridge?.webView?.evaluateJavaScript(js)
        }
    }

    private func emitError(code: Int, message: String) {
        let safeMsg = message.replacingOccurrences(of: "'", with: "\\'")
        let js = "window.dispatchEvent(new CustomEvent('nativePlayerError', { detail: { code: \(code), message: '\(safeMsg)' } }));"
        DispatchQueue.main.async { [weak self] in
            self?.bridge?.webView?.evaluateJavaScript(js)
        }
    }

    private func emitTracksChanged() {
        guard let item = player?.currentItem,
              let group = item.asset.mediaSelectionGroup(forMediaCharacteristic: .audible) else { return }

        var audioTracks: [[String: Any]] = []
        for (index, option) in group.options.enumerated() {
            let locale = option.locale ?? Locale(identifier: "und")
            audioTracks.append([
                "id": "audio-\(index)",
                "language": locale.languageCode ?? "und",
                "label": option.displayName,
            ])
        }

        let jsonData = try? JSONSerialization.data(withJSONObject: audioTracks)
        let jsonString = String(data: jsonData ?? Data(), encoding: .utf8) ?? "[]"

        let js = "window.dispatchEvent(new CustomEvent('nativePlayerTracksChanged', { detail: { audioTracks: \(jsonString), subtitleTracks: [] } }));"
        DispatchQueue.main.async { [weak self] in
            self?.bridge?.webView?.evaluateJavaScript(js)
        }
    }
}
