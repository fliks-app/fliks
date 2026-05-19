import Foundation
import Capacitor
import AVFoundation
import AVKit

/// UIView subclass that keeps its first CALayer sublayer (the AVPlayerLayer) sized to bounds.
private class PlayerContainerView: UIView {
    override func layoutSubviews() {
        super.layoutSubviews()
        // Resize the AVPlayerLayer to match the view bounds on rotation
        layer.sublayers?.first { $0 is AVPlayerLayer }?.frame = bounds
    }
}

/**
 * Capacitor plugin wrapping AVPlayer for native HLS playback on iOS.
 * Renders behind the WKWebView — the Angular UI overlays on top.
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
        CAPPluginMethod(name: "setSubtitleStyle", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBrightness", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setMaxResolution", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPosition", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPlaybackRate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSubtitleText", returnType: CAPPluginReturnPromise),
    ]

    private var player: AVPlayer?
    private var playerLayer: AVPlayerLayer?
    private var playerView: UIView?
    private var subtitleLabel: UILabel?
    private var subtitleView: UIView?
    private var subtitleBottomConstraint: NSLayoutConstraint?
    private var timeObserver: Any?
    private var statusObserver: NSKeyValueObservation?
    private var rateObserver: NSKeyValueObservation?
    private var firstFrameObserver: NSKeyValueObservation?
    private var firstFrameEmitted = false
    private var savedBrightness: CGFloat?

    /// Exposed for PipPlugin to access the player layer.
    public var activePlayerLayer: AVPlayerLayer? { playerLayer }
    /// Exposed for PipPlugin to access the player.
    public var activePlayer: AVPlayer? { player }

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

            let parentBounds = webView.superview?.bounds ?? UIScreen.main.bounds
            let isFullScreen = (width < 0 && height < 0)
            let frame = isFullScreen
                ? parentBounds
                : CGRect(x: CGFloat(x), y: CGFloat(y), width: CGFloat(width), height: CGFloat(height))

            let view = PlayerContainerView(frame: frame)
            view.backgroundColor = .black

            if isFullScreen {
                view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            }

            // Insert BEHIND the WebView
            webView.superview?.insertSubview(view, belowSubview: webView)

            // Make WebView transparent
            webView.isOpaque = false
            webView.backgroundColor = .clear
            webView.scrollView.backgroundColor = .clear

            self.playerView = view

            // Create subtitle view between player and WebView
            let subContainer = UIView(frame: parentBounds)
            subContainer.backgroundColor = .clear
            subContainer.isUserInteractionEnabled = false
            if isFullScreen {
                subContainer.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            }
            webView.superview?.insertSubview(subContainer, belowSubview: webView)

            let label = UILabel()
            label.translatesAutoresizingMaskIntoConstraints = false
            label.textColor = .white
            label.font = .systemFont(ofSize: 20, weight: .semibold)
            label.textAlignment = .center
            label.numberOfLines = 0
            label.layer.shadowColor = UIColor.black.cgColor
            label.layer.shadowOffset = CGSize(width: 0, height: 1)
            label.layer.shadowRadius = 4
            label.layer.shadowOpacity = 0.9
            subContainer.addSubview(label)

            let bottomConstraint = label.bottomAnchor.constraint(equalTo: subContainer.safeAreaLayoutGuide.bottomAnchor, constant: -40)
            NSLayoutConstraint.activate([
                label.leadingAnchor.constraint(equalTo: subContainer.leadingAnchor, constant: 24),
                label.trailingAnchor.constraint(equalTo: subContainer.trailingAnchor, constant: -24),
                bottomConstraint,
            ])
            self.subtitleBottomConstraint = bottomConstraint

            self.subtitleLabel = label
            self.subtitleView = subContainer

            // Keep screen awake during playback
            UIApplication.shared.isIdleTimerDisabled = true

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
                width: width < 0 ? UIScreen.main.bounds.width : CGFloat(width),
                height: height < 0 ? UIScreen.main.bounds.height : CGFloat(height)
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

        // Trace what URL the engine is asking us to load — confirms in
        // console which playback path stream-builder picked (DirectPlay
        // raw / DirectStream remux master / Transcode master).
        let safeUrl = urlString.replacingOccurrences(of: "'", with: "\\'")
        let logJs = "console.warn('[NativePlayer] load', '\(safeUrl)', 'startTime=\(startTime)');"
        DispatchQueue.main.async { [weak self] in
            self?.bridge?.webView?.evaluateJavaScript(logJs)
        }

        // Diagnostic: when the URL points at an HLS master playlist, fetch
        // it ourselves and dump the body to console BEFORE handing it to
        // AVPlayer. Captured CODECS / BANDWIDTH / VIDEO-RANGE values so
        // we can reproduce a -12927 rejection that came back with an
        // empty errorLog. Gated on DEBUG: in release the extra fetch
        // adds 100ms-3s of cellular latency to every load.
        #if DEBUG
        if urlString.contains(".m3u8") {
            var req = URLRequest(url: url)
            for (k, v) in headers {
                if let s = v as? String { req.setValue(s, forHTTPHeaderField: k) }
            }
            URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
                guard let body = data.flatMap({ String(data: $0, encoding: .utf8) }) else { return }
                let escaped = body
                    .replacingOccurrences(of: "\\", with: "\\\\")
                    .replacingOccurrences(of: "'", with: "\\'")
                    .replacingOccurrences(of: "\n", with: "\\n")
                let dumpJs = "console.warn('[NativePlayer] manifest:\\n' + '\(escaped)');"
                DispatchQueue.main.async {
                    self?.bridge?.webView?.evaluateJavaScript(dumpJs)
                }
            }.resume()
        }
        #endif

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }

            // Clean up previous player
            self.removeObservers()
            self.firstFrameEmitted = false
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

            // Preload `playable`/`tracks`/`duration` so `.readyToPlay` fires
            // without a second round-trip after the asset header arrives.
            let playerItem = AVPlayerItem(
                asset: asset,
                automaticallyLoadedAssetKeys: ["playable", "tracks", "duration"]
            )
            // No initial bitrate / resolution caps. We used to clamp these
            // to the device's native screen to fight per-rung FFmpeg
            // session thrash, but the cap also silently rejected the
            // single-variant HDR pass-through manifest when the source
            // resolution (e.g. 3840×2160) exceeded the screen native size
            // (e.g. 1290×2796 on iPhone 15 Pro Max). AVPlayer had no
            // lower variant to fall back to, errored out with CoreMedia
            // -12927, and the errorLog stayed empty because the failure
            // happened at variant selection — before any segment fetch.
            // ABR runs freely; `setMaxResolution` from the engine still
            // applies a cap when the user explicitly picks a quality.
            let player = AVPlayer(playerItem: playerItem)
            // Don't second-guess AVPlayer's prebuffer — let it wait until it
            // has enough video to play without immediate stall.
            player.automaticallyWaitsToMinimizeStalling = true
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

            // Seek BEFORE play so AVPlayer's initial prebuffer probe
            // (gated by automaticallyWaitsToMinimizeStalling=true on
            // an .unknown item) fires at the resume target, not at
            // content time 0. On transcoded HLS the backend pre-spawns
            // ffmpeg at startSegment and only warms segments forward —
            // a probe at seg-0 / seg-1 cold-spawns a second session.
            // AVPlayer queues seek and play on .unknown items and
            // applies both once the asset is loaded. play() runs
            // unconditionally rather than inside the seek completion
            // handler — Apple's docs say the completion may fire with
            // finished=false when AVPlayer pre-empts our seek with
            // its own status-flip seek, and we would then never start
            // playback (the symptom that bit us originally: load()
            // resolved but playback stayed paused).
            if startTime > 0 {
                let cmTime = CMTime(seconds: startTime, preferredTimescale: 1000)
                player.seek(to: cmTime)
            }
            player.play()

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
        // Return stub ID — frontend handles subtitle display via HTML overlay.
        let id = "ext-sub-\(Int(Date().timeIntervalSince1970 * 1000))"
        call.resolve(["id": id])
    }

    // MARK: - Subtitle Style

    @objc func setSubtitleStyle(_ call: CAPPluginCall) {
        let fontScale = call.getFloat("fontScale") ?? 1.0
        let foregroundColor = call.getString("foregroundColor") ?? "#FFFFFF"
        let backgroundColor = call.getString("backgroundColor") ?? "transparent"
        let edgeType = call.getString("edgeType") ?? "none"
        let bottomMargin = CGFloat(call.getFloat("bottomMarginPercent") ?? 8.0)

        DispatchQueue.main.async { [weak self] in
            guard let label = self?.subtitleLabel,
                  let container = self?.subtitleView else {
                call.resolve()
                return
            }

            // Font size: base 20pt scaled
            let baseSize: CGFloat = 20.0
            label.font = .systemFont(ofSize: baseSize * CGFloat(fontScale), weight: .semibold)

            // Foreground color
            if let argb = self?.parseColor(foregroundColor) {
                label.textColor = UIColor(
                    red: argb[1], green: argb[2], blue: argb[3], alpha: argb[0]
                )
            }

            // Background
            if backgroundColor == "transparent" {
                label.backgroundColor = .clear
            } else if let argb = self?.parseColor(backgroundColor) {
                label.backgroundColor = UIColor(
                    red: argb[1], green: argb[2], blue: argb[3], alpha: argb[0]
                )
            }

            // Shadow / edge type
            switch edgeType {
            case "drop_shadow":
                label.layer.shadowColor = UIColor.black.cgColor
                label.layer.shadowOffset = CGSize(width: 0, height: 2)
                label.layer.shadowRadius = 4
                label.layer.shadowOpacity = 0.9
            case "outline":
                label.layer.shadowColor = UIColor.black.cgColor
                label.layer.shadowOffset = .zero
                label.layer.shadowRadius = 2
                label.layer.shadowOpacity = 1.0
            case "raised":
                label.layer.shadowColor = UIColor.black.cgColor
                label.layer.shadowOffset = CGSize(width: 1, height: 1)
                label.layer.shadowRadius = 6
                label.layer.shadowOpacity = 0.8
            default:
                label.layer.shadowOpacity = 0
            }

            // Bottom margin
            let screenHeight = UIScreen.main.bounds.height
            self?.subtitleBottomConstraint?.constant = -(screenHeight * bottomMargin / 100)

            call.resolve()
        }
    }

    // MARK: - Brightness

    @objc func setBrightness(_ call: CAPPluginCall) {
        let brightness = call.getFloat("brightness") ?? -1

        DispatchQueue.main.async { [weak self] in
            if brightness < 0 {
                // Restore original brightness
                if let saved = self?.savedBrightness {
                    UIScreen.main.brightness = saved
                    self?.savedBrightness = nil
                }
            } else {
                // Save original brightness on first call
                if self?.savedBrightness == nil {
                    self?.savedBrightness = UIScreen.main.brightness
                }
                UIScreen.main.brightness = CGFloat(brightness)
            }
            call.resolve()
        }
    }

    // MARK: - Quality

    @objc func setMaxResolution(_ call: CAPPluginCall) {
        let width = call.getInt("width") ?? 0
        let height = call.getInt("height") ?? 0

        DispatchQueue.main.async { [weak self] in
            guard let item = self?.player?.currentItem else {
                call.resolve()
                return
            }

            if width == 0 && height == 0 {
                // Auto: lift both caps so AVPlayer's ABR runs freely.
                item.preferredMaximumResolution = .zero
                item.preferredPeakBitRate = 0  // 0 = no limit
            } else {
                // AVPlayer HLS has no "disable ABR" switch. Combining a tight
                // resolution cap with a peak-bitrate ceiling just above the
                // target profile forces AVPlayer to pick that rung and prevents
                // upward switches. Downward switching under real congestion is
                // still possible — Apple's ABR can't be hard-locked without
                // rewriting the master playlist to expose a single rung.
                item.preferredMaximumResolution = CGSize(width: width, height: height)
                item.preferredPeakBitRate = Self.peakBitRateForHeight(height)
            }
            call.resolve()
        }
    }

    /// Peak bitrate ceiling (bps) tuned just above the transcode profile for
    /// the given target height. Keeps AVPlayer pinned to that rung instead of
    /// upgrading to the next profile. Mirrors backend PROFILES in
    /// transcoding.service.ts — update both if bitrates change.
    private static func peakBitRateForHeight(_ height: Int) -> Double {
        switch height {
        case 2160...: return 40_000_000   // profile 20M → cap 40M (no upper profile)
        case 1080..<2160: return 12_000_000  // profile 8M, next 20M
        case 720..<1080: return 6_000_000    // profile 4M, next 8M
        case 480..<720: return 3_000_000     // profile 2M, next 4M
        case 360..<480: return 1_500_000     // profile 1M, next 2M
        case 240..<360: return 750_000       // profile 500k, next 1M
        default: return 350_000              // 144p profile 200k, next 500k
        }
    }

    // MARK: - Subtitles (HTML-free overlay)

    @objc func setSubtitleText(_ call: CAPPluginCall) {
        let text = call.getString("text") ?? ""
        DispatchQueue.main.async { [weak self] in
            self?.subtitleLabel?.text = text.isEmpty ? nil : text
            call.resolve()
        }
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

    // MARK: - Private Helpers

    private func setupObservers() {
        guard let player = player else { return }

        // Periodic time observer (every second)
        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 1, preferredTimescale: 1000),
            queue: .main
        ) { [weak self] _ in
            self?.emitTimeUpdate()
        }

        // Playback status
        statusObserver = player.currentItem?.observe(\.status) { [weak self] item, _ in
            switch item.status {
            case .readyToPlay:
                self?.emitStateChanged("playing")
                self?.emitTracksChanged()
            case .failed:
                let nsError = item.error as NSError?
                let msg = nsError?.localizedDescription ?? "Playback failed"
                let code = nsError?.code ?? -1
                // Dump the AVPlayerItem error log to the console — each
                // entry carries the exact failing URI (which segment),
                // errorStatusCode, and errorComment (Apple's own
                // description). With raw -12927 we're blind; with this
                // we see WHY AVPlayer rejected the variant.
                var details: [String] = []
                if let log = item.errorLog() {
                    for entry in log.events {
                        details.append(
                            "[\(entry.errorDomain) \(entry.errorStatusCode)] \(entry.errorComment ?? "—") uri=\(entry.uri ?? "—")"
                        )
                    }
                }
                self?.emitError(code: code, message: msg + (details.isEmpty ? "" : "\n" + details.joined(separator: "\n")))
            default:
                break
            }
        }

        // AVPlayerItem error log — fires on every recoverable / fatal
        // network or codec event during playback. More verbose than the
        // single `.status == .failed` emit above (which only fires once,
        // and with a single error). This catches per-segment failures,
        // codec validation hiccups, and ABR-related rejections.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleNewErrorLogEntry(_:)),
            name: AVPlayerItem.newErrorLogEntryNotification,
            object: player.currentItem
        )

        // Rate changes (play/pause detection)
        rateObserver = player.observe(\.rate) { [weak self] player, _ in
            if player.rate == 0 {
                self?.emitStateChanged("paused")
            } else {
                self?.emitStateChanged("playing")
            }
        }

        // First-frame painted — flip the Angular fanart/spinner off.
        // `AVPlayerLayer.isReadyForDisplay` is the canonical signal that
        // the layer has decoded + composited a frame to the surface;
        // mirrors ExoPlayer's `onRenderedFirstFrame` on Android.
        // `initial: .new` fires once synchronously, so we gate on
        // `firstFrameEmitted` to skip the pre-load `false` value and emit
        // only on the actual flip to `true`.
        if let layer = playerLayer {
            firstFrameObserver = layer.observe(\.isReadyForDisplay, options: [.new]) { [weak self] layer, _ in
                guard let self = self, layer.isReadyForDisplay, !self.firstFrameEmitted else { return }
                self.firstFrameEmitted = true
                self.emitFirstFrame()
            }
        }

        // Buffering detection
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(playerStalled),
            name: .AVPlayerItemPlaybackStalled,
            object: player.currentItem
        )

        // Ended detection
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(playerDidFinishPlaying),
            name: .AVPlayerItemDidPlayToEndTime,
            object: player.currentItem
        )
    }

    @objc private func playerStalled() {
        emitStateChanged("buffering")
    }

    @objc private func handleNewErrorLogEntry(_ notification: Notification) {
        guard let item = notification.object as? AVPlayerItem,
              let log = item.errorLog(),
              let entry = log.events.last else { return }
        let msg = "[\(entry.errorDomain) \(entry.errorStatusCode)] \(entry.errorComment ?? "—") uri=\(entry.uri ?? "—")"
        // Dump to JS console so it shows up in Safari Web Inspector / app
        // log, AND emit as a soft error event for the UI to surface.
        let escaped = msg.replacingOccurrences(of: "'", with: "\\'")
        let js = "console.warn('[NativePlayer] errorLog:', '\(escaped)');"
        DispatchQueue.main.async { [weak self] in
            self?.bridge?.webView?.evaluateJavaScript(js)
        }
    }

    @objc private func playerDidFinishPlaying() {
        emitStateChanged("ended")
    }

    private func removeObservers() {
        if let obs = timeObserver {
            player?.removeTimeObserver(obs)
            timeObserver = nil
        }
        statusObserver?.invalidate()
        statusObserver = nil
        firstFrameObserver?.invalidate()
        firstFrameObserver = nil
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
        subtitleView?.removeFromSuperview()
        subtitleView = nil
        subtitleLabel = nil
        subtitleBottomConstraint = nil


        // Restore brightness
        if let saved = savedBrightness {
            UIScreen.main.brightness = saved
            savedBrightness = nil
        }

        // Allow screen to sleep
        UIApplication.shared.isIdleTimerDisabled = false
    }

    private func getBufferedPosition() -> Double {
        guard let ranges = player?.currentItem?.loadedTimeRanges else { return 0 }
        if let range = ranges.last?.timeRangeValue {
            let end = CMTimeGetSeconds(range.start) + CMTimeGetSeconds(range.duration)
            return end.isFinite ? end : 0
        }
        return 0
    }

    /// Parse hex color string (#RGB, #RRGGBB, #AARRGGBB) into ARGB array for CMTextMarkup.
    private func parseColor(_ hex: String) -> [CGFloat]? {
        var h = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if h.hasPrefix("#") { h.removeFirst() }

        var a: CGFloat = 1.0
        var r: CGFloat = 1.0
        var g: CGFloat = 1.0
        var b: CGFloat = 1.0

        guard let val = UInt64(h, radix: 16) else { return nil }

        switch h.count {
        case 6: // RRGGBB
            r = CGFloat((val >> 16) & 0xFF) / 255.0
            g = CGFloat((val >> 8) & 0xFF) / 255.0
            b = CGFloat(val & 0xFF) / 255.0
        case 8: // AARRGGBB
            a = CGFloat((val >> 24) & 0xFF) / 255.0
            r = CGFloat((val >> 16) & 0xFF) / 255.0
            g = CGFloat((val >> 8) & 0xFF) / 255.0
            b = CGFloat(val & 0xFF) / 255.0
        default:
            return nil
        }

        return [a, r, g, b]
    }

    // MARK: - Event Emitters

    private func emitStateChanged(_ state: String) {
        let js = "window.dispatchEvent(new CustomEvent('nativePlayerStateChanged', { detail: { state: '\(state)' } }));"
        DispatchQueue.main.async { [weak self] in
            self?.bridge?.webView?.evaluateJavaScript(js)
        }
    }

    private func emitFirstFrame() {
        let js = "window.dispatchEvent(new CustomEvent('nativePlayerFirstFrame'));"
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
        // Always log to console.error so the failure is visible in Safari
        // Web Inspector regardless of whether the Angular layer surfaces
        // the dispatched event.
        let js = """
        console.error('[NativePlayer] error', \(code), '\(safeMsg)');
        window.dispatchEvent(new CustomEvent('nativePlayerError', { detail: { code: \(code), message: '\(safeMsg)' } }));
        """
        DispatchQueue.main.async { [weak self] in
            self?.bridge?.webView?.evaluateJavaScript(js)
        }
    }

    private func emitTracksChanged() {
        guard let item = player?.currentItem else { return }

        var audioTracks: [[String: Any]] = []
        if let group = item.asset.mediaSelectionGroup(forMediaCharacteristic: .audible) {
            for (index, option) in group.options.enumerated() {
                let locale = option.locale ?? Locale(identifier: "und")
                audioTracks.append([
                    "id": "audio-\(index)",
                    "language": locale.languageCode ?? "und",
                    "label": option.displayName,
                ])
            }
        }

        var subtitleTracks: [[String: Any]] = []
        if let group = item.asset.mediaSelectionGroup(forMediaCharacteristic: .legible) {
            for (index, option) in group.options.enumerated() {
                let locale = option.locale ?? Locale(identifier: "und")
                subtitleTracks.append([
                    "id": "text-\(index)",
                    "language": locale.languageCode ?? "und",
                    "label": option.displayName,
                ])
            }
        }

        let audioData = try? JSONSerialization.data(withJSONObject: audioTracks)
        let audioJson = String(data: audioData ?? Data(), encoding: .utf8) ?? "[]"
        let subData = try? JSONSerialization.data(withJSONObject: subtitleTracks)
        let subJson = String(data: subData ?? Data(), encoding: .utf8) ?? "[]"

        let js = "window.dispatchEvent(new CustomEvent('nativePlayerTracksChanged', { detail: { audioTracks: \(audioJson), subtitleTracks: \(subJson) } }));"
        DispatchQueue.main.async { [weak self] in
            self?.bridge?.webView?.evaluateJavaScript(js)
        }
    }
}
