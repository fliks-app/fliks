import Foundation
import Capacitor
import AVFoundation
import AVKit
import CoreMedia

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
        CAPPluginMethod(name: "setSubtitleStyle", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBrightness", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setMaxResolution", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPosition", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPlaybackRate", returnType: CAPPluginReturnPromise),
    ]

    private var player: AVPlayer?
    private var playerLayer: AVPlayerLayer?
    private var playerView: UIView?
    private var timeObserver: Any?
    private var statusObserver: NSKeyValueObservation?
    private var timeControlObserver: NSKeyValueObservation?
    private var firstFrameObserver: NSKeyValueObservation?
    private var firstFrameEmitted = false
    private var savedBrightness: CGFloat?
    /// AVTextStyleRule built from the app's subtitle-style settings, applied
    /// to each AVPlayerItem so native (legible) caption rendering honours the
    /// chosen colours / background instead of AVPlayer's default grey box.
    private var subtitleStyleRules: [AVTextStyleRule] = []

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
        let headers = parseHeaders(call.getObject("headers"))

        logLoad(urlString: urlString, startTime: startTime)
        dumpManifestForDebug(url: url, headers: headers)

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.removeObservers()
            self.firstFrameEmitted = false
            self.player?.pause()

            // Audio session can be flipped out of `.playback` by a phone
            // call, route change, or Siri. AppDelegate sets it once at
            // launch — reasserting on every load defends against any
            // subsequent corruption that would otherwise have AVPlayer
            // start with audio in a mute or downmixed state.
            self.ensureAudioSessionActive()

            let item = self.buildPlayerItem(url: url, assetHeaders: headers)
            let player = self.attachPlayerItem(item)
            self.setupObservers()
            self.startPlayback(player: player, startTime: startTime)

            call.resolve()
        }
    }

    private func parseHeaders(_ raw: [String: Any]?) -> [String: String] {
        var out: [String: String] = [:]
        for (key, value) in raw ?? [:] {
            if let str = value as? String { out[key] = str }
        }
        return out
    }

    private func logLoad(urlString: String, startTime: Double) {
        let safeUrl = urlString.replacingOccurrences(of: "'", with: "\\'")
        let js = "console.warn('[NativePlayer] load', '\(safeUrl)', 'startTime=\(startTime)');"
        DispatchQueue.main.async { [weak self] in
            self?.bridge?.webView?.evaluateJavaScript(js)
        }
    }

    /// Debug-only manifest dump. Captures the exact CODECS / BANDWIDTH /
    /// VIDEO-RANGE the player sees, so a `-12927` rejection that comes
    /// back with an empty `errorLog` can be reproduced from the trace.
    /// Skipped in release builds (the extra fetch adds 100ms-3s of
    /// cellular latency to every load).
    private func dumpManifestForDebug(url: URL, headers: [String: String]) {
        #if DEBUG
        guard url.absoluteString.contains(".m3u8") else { return }
        var req = URLRequest(url: url)
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            guard let body = data.flatMap({ String(data: $0, encoding: .utf8) }) else { return }
            let escaped = body
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
                .replacingOccurrences(of: "\n", with: "\\n")
            let js = "console.warn('[NativePlayer] manifest:\\n' + '\(escaped)');"
            DispatchQueue.main.async {
                self?.bridge?.webView?.evaluateJavaScript(js)
            }
        }.resume()
        #endif
    }

    private func ensureAudioSessionActive() {
        let session = AVAudioSession.sharedInstance()
        do {
            if session.category != .playback {
                try session.setCategory(
                    .playback,
                    mode: .moviePlayback,
                    options: [.allowAirPlay, .allowBluetoothA2DP]
                )
            }
            try session.setActive(true)
        } catch {
            // Best effort. AVPlayer keeps playing on whatever session
            // state was active before — degraded audio is preferable to
            // a hard load failure.
        }
    }

    /// Build the AVPlayerItem with a 4-second forward buffer hint.
    /// `preferredForwardBufferDuration = 4` (≈ one full GOP-cut HLS
    /// segment plus margin) gives AVPlayer a consistent prebuffer
    /// target before it flips `timeControlStatus` to `.playing` —
    /// without it, the default "as needed" heuristic can start
    /// audio decode while video is still resolving its first IDR
    /// and we briefly hear sound over a black frame at startup.
    private func buildPlayerItem(url: URL, assetHeaders: [String: String]) -> AVPlayerItem {
        let assetOptions: [String: Any]? = assetHeaders.isEmpty
            ? nil
            : ["AVURLAssetHTTPHeaderFieldsKey": assetHeaders]
        let asset = AVURLAsset(url: url, options: assetOptions)
        // Preload `playable`/`tracks`/`duration` so `.readyToPlay` fires
        // without a second round-trip after the asset header arrives.
        let item = AVPlayerItem(
            asset: asset,
            automaticallyLoadedAssetKeys: ["playable", "tracks", "duration"]
        )
        item.preferredForwardBufferDuration = 4
        return item
    }

    /// Attach the new item to the existing AVPlayer (via
    /// `replaceCurrentItem`) when one exists, otherwise spin up a fresh
    /// player + layer. Reusing the player keeps observers, audio session
    /// bindings, and PiP wiring stable across loads — the previous
    /// "new AVPlayer per load" pattern left a small window where the
    /// PipPlugin could still hold the prior layer's player while we
    /// were swapping in the next one.
    ///
    /// No initial bitrate / resolution caps. We used to clamp these to
    /// the device's native screen to fight per-rung FFmpeg session
    /// thrash, but the cap also silently rejected the single-variant
    /// HDR pass-through manifest when source resolution exceeded the
    /// screen (-12927 with an empty errorLog). ABR runs freely now;
    /// `setMaxResolution` from the engine still applies a cap when the
    /// user explicitly picks a quality.
    @discardableResult
    private func attachPlayerItem(_ item: AVPlayerItem) -> AVPlayer {
        // Carry the chosen subtitle styling onto every new item (set before
        // the first load, kept across loads).
        if !subtitleStyleRules.isEmpty {
            item.textStyleRules = subtitleStyleRules
        }
        if let existing = player {
            existing.replaceCurrentItem(with: item)
            existing.automaticallyWaitsToMinimizeStalling = true
            return existing
        }
        let player = AVPlayer(playerItem: item)
        player.automaticallyWaitsToMinimizeStalling = true
        self.player = player
        if playerLayer == nil, let view = playerView {
            let layer = AVPlayerLayer(player: player)
            layer.frame = view.bounds
            layer.videoGravity = .resizeAspect
            view.layer.addSublayer(layer)
            playerLayer = layer
        } else {
            playerLayer?.player = player
        }
        return player
    }

    /// Seek (frame-accurate, `.zero` tolerance on both sides) then
    /// kick `play()`. The zero tolerance is the critical bit: with the
    /// default `±infinity` tolerance, AVPlayer is free to snap each
    /// stream to its own nearest keyframe — audio AAC frames sit at
    /// every ~21 ms, video keyframes only at IDR boundaries (every
    /// segment, ~3 s). That asymmetry would let audio land 0-3 s
    /// before video → the "big A/V desync on resume that goes away
    /// after a close + reopen" symptom (reopen used `startTime=0`,
    /// which skipped the seek entirely).
    ///
    /// `play()` runs outside any seek completion handler. Apple's docs
    /// say the completion may report `finished=false` when AVPlayer
    /// pre-empts our seek with its own status-flip seek; conditioning
    /// play on that flag would leave playback paused forever in that
    /// race.
    private func startPlayback(player: AVPlayer, startTime: Double) {
        if startTime > 0 {
            let cmTime = CMTime(seconds: startTime, preferredTimescale: 1000)
            player.seek(to: cmTime, toleranceBefore: .zero, toleranceAfter: .zero)
        }
        player.play()
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
            guard let player = self?.player else {
                call.resolve()
                return
            }
            let cmTime = CMTime(seconds: position, preferredTimescale: 1000)
            // Resolve only AFTER AVPlayer finishes the seek. Resolving
            // synchronously (the old behaviour) made the JS layer think
            // the engine was at `position` immediately, the seek-lock
            // released, and the next time-observer tick with a still-
            // mid-seek `player.currentTime()` (often 0 because CMTime
            // briefly becomes .indefinite during the transition)
            // snapped the seekbar back to 0 before AVPlayer settled at
            // the target — the visible "forward → back to 0 → forward"
            // hop. Apple guarantees the completion fires even when our
            // seek is pre-empted by a subsequent seek (finished=false),
            // so this never hangs.
            player.seek(
                to: cmTime,
                toleranceBefore: .zero,
                toleranceAfter: .zero
            ) { _ in
                call.resolve()
            }
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

    // MARK: - Subtitle Style

    @objc func setSubtitleStyle(_ call: CAPPluginCall) {
        let fontScale = call.getFloat("fontScale") ?? 1.0
        let foregroundColor = call.getString("foregroundColor") ?? "#FFFFFF"
        let backgroundColor = call.getString("backgroundColor") ?? "transparent"
        let edgeType = call.getString("edgeType") ?? "none"
        // `bottomMarginPercent` has no AVTextStyleRule equivalent — native
        // legible captions position themselves; the setting is honoured on
        // the web/TV (overlay) engines only.

        DispatchQueue.main.async { [weak self] in
            guard let self = self else {
                call.resolve()
                return
            }

            // Native legible rendering: drive AVPlayer's caption styling via
            // AVTextStyleRule so the app's subtitle settings actually apply.
            // Without it AVPlayer draws its built-in caption box (grey, semi-
            // opaque) regardless of the chosen background. Stored so each
            // newly attached item picks the same rules up (see attachPlayerItem).
            let rules = self.buildSubtitleStyleRules(
                fontScale: fontScale,
                foregroundColor: foregroundColor,
                backgroundColor: backgroundColor,
                edgeType: edgeType
            )
            self.subtitleStyleRules = rules
            self.player?.currentItem?.textStyleRules = rules
            call.resolve()
        }
    }

    /// Map the app's subtitle-style settings to AVTextStyleRule attributes so
    /// AVPlayer's native legible caption rendering honours them — most
    /// importantly a transparent background (no caption box) when the user
    /// hasn't chosen one. Returns an empty list if the markup attributes can't
    /// be formed, leaving AVPlayer's defaults in place.
    private func buildSubtitleStyleRules(
        fontScale: Float,
        foregroundColor: String,
        backgroundColor: String,
        edgeType: String
    ) -> [AVTextStyleRule] {
        var attrs: [String: Any] = [:]
        if let fg = parseColor(foregroundColor) {
            attrs[kCMTextMarkupAttribute_ForegroundColorARGB as String] = fg
        }
        // "transparent" → fully transparent ARGB so no caption box is drawn.
        // Set BOTH backgrounds: AVPlayer draws the visible box behind WebVTT
        // cues from the *character* background, so clearing only the region
        // `BackgroundColorARGB` leaves a semi-opaque box behind.
        let bg: [CGFloat] =
            backgroundColor == "transparent"
            ? [0, 0, 0, 0]
            : (parseColor(backgroundColor) ?? [0, 0, 0, 0])
        attrs[kCMTextMarkupAttribute_BackgroundColorARGB as String] = bg
        attrs[kCMTextMarkupAttribute_CharacterBackgroundColorARGB as String] = bg
        // Font size as a percentage of video height (~5% ≈ AVPlayer's default
        // caption size), scaled by the user's size factor.
        attrs[kCMTextMarkupAttribute_BaseFontSizePercentageRelativeToVideoHeight as String] =
            Double(5.0 * fontScale)
        let edge: CFString
        switch edgeType {
        case "drop_shadow": edge = kCMTextMarkupCharacterEdgeStyle_DropShadow
        case "outline": edge = kCMTextMarkupCharacterEdgeStyle_Uniform
        case "raised": edge = kCMTextMarkupCharacterEdgeStyle_Raised
        default: edge = kCMTextMarkupCharacterEdgeStyle_None
        }
        attrs[kCMTextMarkupAttribute_CharacterEdgeStyle as String] = edge
        guard let rule = AVTextStyleRule(textMarkupAttributes: attrs) else {
            return []
        }
        return [rule]
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

        // Item status. `.initial` catches a warm asset that flipped to
        // `.readyToPlay` between item creation and observer attach, so the
        // track list still surfaces. Play / pause / buffer state is owned by
        // the `timeControlStatus` observer below, not this one — here
        // `.readyToPlay` only publishes tracks and `.failed` raises the
        // terminal error.
        statusObserver = player.currentItem?.observe(
            \.status, options: [.initial, .new]
        ) { [weak self] item, _ in
            switch item.status {
            case .readyToPlay:
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

        // Single source of truth for play / pause / buffer. With
        // `automaticallyWaitsToMinimizeStalling = true` AVPlayer signals a
        // stall and its recovery through `timeControlStatus`, not `rate`
        // (which holds at the requested value across a re-buffer) — so a
        // `\.rate` observer never fires when playback resumes and the JS
        // spinner would latch. `.waitingToPlayAtSpecifiedRate` is buffering,
        // `.playing` is started/resumed, `.paused` is user pause or stop.
        // `.initial` publishes the status at attach so a warm reload that is
        // already `.playing` emits too; a cold load reports `.paused` here,
        // harmlessly, just before play() starts it.
        timeControlObserver = player.observe(\.timeControlStatus, options: [.initial, .new]) { [weak self] player, _ in
            switch player.timeControlStatus {
            case .paused:
                self?.emitStateChanged("paused")
            case .waitingToPlayAtSpecifiedRate:
                self?.emitStateChanged("buffering")
            case .playing:
                self?.emitStateChanged("playing")
            @unknown default:
                break
            }
        }

        // First-frame painted — flip the Angular fanart/spinner off.
        // `AVPlayerLayer.isReadyForDisplay` is the canonical signal that
        // the layer has decoded + composited a frame to the surface;
        // mirrors ExoPlayer's `onRenderedFirstFrame` on Android.
        // `.initial` catches a layer already ready at observer attach (warm
        // reload); KVO otherwise fires on each `isReadyForDisplay` transition.
        // The `firstFrameEmitted` flag makes the emit one-shot, dropping the
        // `false` values and any later re-ready toggles across re-buffers.
        if let layer = playerLayer {
            firstFrameObserver = layer.observe(\.isReadyForDisplay, options: [.initial, .new]) { [weak self] layer, _ in
                guard let self = self, layer.isReadyForDisplay, !self.firstFrameEmitted else { return }
                self.firstFrameEmitted = true
                self.emitFirstFrame()
            }
        }

        // Ended detection
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(playerDidFinishPlaying),
            name: .AVPlayerItemDidPlayToEndTime,
            object: player.currentItem
        )
    }

    @objc private func handleNewErrorLogEntry(_ notification: Notification) {
        guard let item = notification.object as? AVPlayerItem,
              let log = item.errorLog(),
              let entry = log.events.last else { return }
        let msg = "[\(entry.errorDomain) \(entry.errorStatusCode)] \(entry.errorComment ?? "—") uri=\(entry.uri ?? "—")"
        // Dump to the JS console (Safari Web Inspector / app log) only.
        // These entries fire on recoverable per-segment network / codec
        // hiccups, so they are deliberately not raised as a UI error
        // event — only the terminal `.status == .failed` path does that.
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
        timeControlObserver?.invalidate()
        timeControlObserver = nil
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
        subtitleStyleRules = []

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
