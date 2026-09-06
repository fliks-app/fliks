import Foundation
import Capacitor
import AVFoundation
import AVKit
import CoreMedia
import UIKit

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
        CAPPluginMethod(name: "setFillScreen", returnType: CAPPluginReturnPromise),
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
    /// Cues are pulled off the selected legible track via this output with
    /// player rendering suppressed, then drawn by `subtitleOverlay` so the app
    /// fully controls styling and no system caption box appears. Inside PiP
    /// (where the overlay isn't captured) suppression is lifted so the native
    /// track draws into the mirrored layer instead.
    private var subtitleOutput: AVPlayerItemLegibleOutput?
    private var subtitleOverlay: SubtitleOverlayView?
    private var currentSubtitleStyle = SubtitleStyle()
    private let legibleQueue = DispatchQueue(label: "fliks.subtitle.legible")
    /// Legible option deselected to clear the native caption while leaving PiP,
    /// restored once PiP has fully exited.
    private var pipDeselectedSubtitle: AVMediaSelectionOption?
    /// Selection groups for the current item. Loaded asynchronously once the
    /// item is ready (the synchronous asset accessor is gone since iOS 16) so
    /// every track call site can stay synchronous.
    private var audibleGroup: AVMediaSelectionGroup?
    private var legibleGroup: AVMediaSelectionGroup?

    /// Exposed for PipPlugin to access the player layer.
    public var activePlayerLayer: AVPlayerLayer? { playerLayer }
    /// Exposed for PipPlugin to access the player.
    public var activePlayer: AVPlayer? { player }

    /// Re-present the AVPlayerLayer after a background round-trip or a PiP
    /// exit. iOS can release the layer's backing render surface for the
    /// off-screen scene (and an auto-PiP exit can leave the inline layer
    /// detached) while AVPlayer keeps decoding audio and the subtitle overlay
    /// keeps drawing — so the inline video returns black over the container's
    /// black backdrop. Rebinding the player, re-stamping the frame and (when
    /// the layer isn't presenting) toggling videoGravity force a recomposite.
    /// Idempotent; safe to call when already presenting.
    func reassertVideoPresentation() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self,
                  let layer = self.playerLayer,
                  let player = self.player,
                  let view = self.playerView else { return }
            // Diagnostic — surfaces on-device whether the returning layer is
            // detached / not-ready (vs ready-but-black) so the recomposite
            // path can be tuned from real logs.
            let state = "ready=\(layer.isReadyForDisplay) attached=\(layer.player != nil) size=\(Int(view.bounds.width))x\(Int(view.bounds.height))"
            self.bridge?.webView?.evaluateJavaScript("console.warn('[NativePlayer] reassert: \(state)');")

            if layer.player !== player { layer.player = player }
            layer.frame = view.bounds
            if !layer.isReadyForDisplay {
                let gravity = layer.videoGravity
                layer.videoGravity = .resize
                layer.videoGravity = gravity
            }
        }
    }

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

            // Custom subtitle overlay above the AVPlayerLayer (and below the
            // transparent WebView, so Angular controls stay on top).
            let overlay = SubtitleOverlayView(frame: view.bounds)
            overlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            overlay.apply(self.currentSubtitleStyle)
            view.addSubview(overlay)
            self.subtitleOverlay = overlay

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
            self.subtitleOverlay?.render([])

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
        // Groups belong to the outgoing asset — selecting one of its options
        // on the new item would raise.
        audibleGroup = nil
        legibleGroup = nil
        // Pull cues off the legible track ourselves (player rendering
        // suppressed) so the custom overlay can draw them box-free.
        attachLegibleOutput(to: item)
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
            // Index 0 keeps the video beneath the subtitle overlay subview.
            view.layer.insertSublayer(layer, at: 0)
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
            self?.audibleGroup = nil
            self?.legibleGroup = nil
            call.resolve()
        }
    }

    // MARK: - Audio Tracks

    @objc func getAudioTracks(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            var tracks: [[String: Any]] = []

            if let item = self?.player?.currentItem,
               let group = self?.audibleGroup {
                let selected = item.currentMediaSelection.selectedMediaOption(in: group)
                for (index, option) in group.options.enumerated() {
                    let locale = option.locale ?? Locale(identifier: "und")
                    tracks.append([
                        "id": "audio-\(index)",
                        "language": locale.language.languageCode?.identifier ?? "und",
                        "label": option.displayName,
                        "selected": option == selected,
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
                  let group = self?.audibleGroup else {
                call.reject("No audio tracks available")
                return
            }

            let index = Int(id.replacingOccurrences(of: "audio-", with: "")) ?? 0
            guard index < group.options.count else {
                call.reject("Invalid track id")
                return
            }

            item.select(group.options[index], in: group)
            // Surface the new selected-state so the audio menu updates — the
            // AVPlayer media-selection change emits no event of its own
            // (Android's onTracksChanged does this automatically).
            self?.emitTracksChanged()
            call.resolve()
        }
    }

    // MARK: - Subtitle Tracks

    @objc func getSubtitleTracks(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            var tracks: [[String: Any]] = []

            if self?.player?.currentItem != nil,
               let group = self?.legibleGroup {
                for (index, option) in group.options.enumerated() {
                    let locale = option.locale ?? Locale(identifier: "und")
                    tracks.append([
                        "id": "text-\(index)",
                        "language": locale.language.languageCode?.identifier ?? "und",
                        "label": option.displayName,
                        // displayName == the manifest NAME (the rendition's
                        // stable id); the engine matches the picked track by it.
                        "forced": option.hasMediaCharacteristic(.containsOnlyForcedSubtitles),
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
                  let group = self?.legibleGroup else {
                call.resolve()
                return
            }

            if let id = id {
                let index = Int(id.replacingOccurrences(of: "text-", with: "")) ?? 0
                if index < group.options.count {
                    item.select(group.options[index], in: group)
                }
            } else {
                // Disable subtitles. Deselecting alone only stops cue delivery;
                // the last cue stays frozen in the overlay, so clear it too.
                item.select(nil, in: group)
                self?.subtitleOverlay?.render([])
            }

            call.resolve()
        }
    }

    // MARK: - Subtitle Style

    @objc func setSubtitleStyle(_ call: CAPPluginCall) {
        let style = SubtitleStyle(
            fontScale: CGFloat(call.getFloat("fontScale") ?? 1.0),
            foregroundHex: call.getString("foregroundColor") ?? "#FFFFFF",
            backgroundHex: call.getString("backgroundColor") ?? "transparent",
            edgeType: call.getString("edgeType") ?? "none",
            bottomMarginPercent: CGFloat(call.getFloat("bottomMarginPercent") ?? 8.0)
        )
        DispatchQueue.main.async { [weak self] in
            guard let self = self else {
                call.resolve()
                return
            }
            self.currentSubtitleStyle = style
            self.subtitleOverlay?.apply(style)
            call.resolve()
        }
    }

    /// Attach a legible output to the item with player rendering suppressed:
    /// cues are delivered to the delegate (and drawn by `subtitleOverlay`)
    /// while AVPlayer draws no caption box. `.sourceAndRulesOnly` keeps the
    /// system's user-preference styling (the box) out of the delivered cues.
    private func attachLegibleOutput(to item: AVPlayerItem) {
        let output = AVPlayerItemLegibleOutput()
        output.suppressesPlayerRendering = true
        output.textStylingResolution = .sourceAndRulesOnly
        output.setDelegate(self, queue: legibleQueue)
        item.add(output)
        subtitleOutput = output
    }

    /// PiP can only mirror the AVPlayerLayer, not the overlay subview. While
    /// PiP is active, lift suppression so AVPlayer renders the (boxed) native
    /// caption into the mirrored layer; restore the overlay on exit.
    /// PiP enter / will-stop. Entering: let AVPlayer draw the (boxed) native
    /// caption into the mirrored layer and hide the overlay. Will-stop:
    /// re-suppress and clear the native caption, but keep the overlay hidden —
    /// it is revealed only once PiP has fully exited (`finishSubtitlePiPExit`),
    /// otherwise it overlaps the boxed caption during the restore animation.
    public func setSubtitleRenderingForPiP(_ inPiP: Bool) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if inPiP {
                self.subtitleOutput?.suppressesPlayerRendering = false
                self.subtitleOverlay?.isHidden = true
            } else {
                self.subtitleOutput?.suppressesPlayerRendering = true
                self.subtitleOverlay?.isHidden = true
                self.clearNativeCaption()
            }
        }
    }

    /// Called once PiP has fully stopped (after the restore animation). Restores
    /// the legible cue flow to the output and reveals the no-box overlay.
    public func finishSubtitlePiPExit() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.restoreLegibleSelection()
            self.subtitleOverlay?.isHidden = false
        }
    }

    /// Deselect the legible option to drop the caption the player rendered
    /// during PiP (re-suppressing alone leaves the last cue frozen on screen).
    /// The option is remembered so cue delivery can be restored on exit.
    private func clearNativeCaption() {
        guard let item = player?.currentItem,
              let group = legibleGroup else { return }
        pipDeselectedSubtitle = item.currentMediaSelection.selectedMediaOption(in: group)
        item.select(nil, in: group)
    }

    private func restoreLegibleSelection() {
        guard let option = pipDeselectedSubtitle,
              let item = player?.currentItem,
              let group = legibleGroup else { return }
        item.select(option, in: group)
        pipDeselectedSubtitle = nil
    }

    // MARK: - Brightness

    // MARK: - Display

    /// Crop-to-fill vs letterbox. `resizeAspectFill` is the AVPlayerLayer
    /// equivalent of `object-fit: cover` — the layer clips the overflow itself.
    @objc func setFillScreen(_ call: CAPPluginCall) {
        let fill = call.getBool("fill") ?? false

        DispatchQueue.main.async { [weak self] in
            self?.playerLayer?.videoGravity = fill ? .resizeAspectFill : .resizeAspect
            call.resolve()
        }
    }

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
                // AVPlayer often reports `.readyToPlay` before the
                // alternate-audio rendition playlists have been fetched, so
                // the `.audible` selection group is still empty. Without
                // this re-emit the client's `audioTracksChanged` upgrade
                // guard rejects the short list, leaves the `si-*` fallback
                // in place, and every language switch falls back to a full
                // backend reload (re-encode). See issue #378.
                self?.ensureMediaSelectionPopulated()
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
            // Screen stays awake while advancing or stalled mid-play; a pause
            // (user pause or end of item) lets it sleep. KVO can land off the
            // main thread, so the UIKit flag has to be hopped over.
            let awake = player.timeControlStatus != .paused
            DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = awake }
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

        // Returning from background / becoming active: iOS can drop the
        // AVPlayerLayer's backing surface for the off-screen scene (or an
        // auto-PiP exit leaves the inline layer detached) while audio and the
        // subtitle overlay keep running — the video returns black. Re-present
        // it. Torn down by removeObservers() and re-added on the next load(),
        // matching the item observers above.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAppDidForeground),
            name: UIApplication.willEnterForegroundNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAppDidForeground),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )
    }

    @objc private func handleAppDidForeground() {
        reassertVideoPresentation()
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
        subtitleOutput = nil
        subtitleOverlay?.removeFromSuperview()
        subtitleOverlay = nil

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

    private func ensureMediaSelectionPopulated(retries: Int = 8) {
        guard let item = player?.currentItem else { return }
        let asset = item.asset
        Task { @MainActor [weak self] in
            let audible = try? await asset.loadMediaSelectionGroup(for: .audible)
            let legible = try? await asset.loadMediaSelectionGroup(for: .legible)
            guard let self = self, self.player?.currentItem === item else { return }
            self.audibleGroup = audible
            self.legibleGroup = legible
            if (audible?.options.count ?? 0) > 0 || (legible?.options.count ?? 0) > 0 {
                self.emitTracksChanged()
                return
            }
            if retries > 0 {
                try? await Task.sleep(nanoseconds: 250_000_000)
                self.ensureMediaSelectionPopulated(retries: retries - 1)
            }
        }
    }

    private func emitTracksChanged() {
        guard let item = player?.currentItem else { return }

        var audioTracks: [[String: Any]] = []
        if let group = audibleGroup {
            let selected = item.currentMediaSelection.selectedMediaOption(in: group)
            for (index, option) in group.options.enumerated() {
                let locale = option.locale ?? Locale(identifier: "und")
                audioTracks.append([
                    "id": "audio-\(index)",
                    "language": locale.language.languageCode?.identifier ?? "und",
                    "label": option.displayName,
                    "selected": option == selected,
                ])
            }
        }

        var subtitleTracks: [[String: Any]] = []
        if let group = legibleGroup {
            for (index, option) in group.options.enumerated() {
                let locale = option.locale ?? Locale(identifier: "und")
                subtitleTracks.append([
                    "id": "text-\(index)",
                    "language": locale.language.languageCode?.identifier ?? "und",
                    "label": option.displayName,
                    "forced": option.hasMediaCharacteristic(.containsOnlyForcedSubtitles),
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

// MARK: - Legible output delegate

extension NativePlayerPlugin: AVPlayerItemLegibleOutputPushDelegate {
    public func legibleOutput(
        _ output: AVPlayerItemLegibleOutput,
        didOutputAttributedStrings strings: [NSAttributedString],
        nativeSampleBuffers nativeSamples: [Any],
        forItemTime itemTime: CMTime
    ) {
        let cues = strings.map { SubtitleRun.runs(from: $0) }
        DispatchQueue.main.async { [weak self] in
            self?.subtitleOverlay?.render(cues)
        }
    }
}
