import Foundation
import Capacitor
import AVFoundation
import AVKit
import CoreMedia
import UIKit


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
        CAPPluginMethod(name: "setCrop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBrightness", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setMaxResolution", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPosition", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getQoe", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPlaybackRate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setQueueNav", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setMuteRanges", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVolume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVoiceActive", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setHeartbeat", returnType: CAPPluginReturnPromise),
    ]

    var player: AVPlayer?
    var playerLayer: AVPlayerLayer?
    var playerView: UIView?
    var timeObserver: Any?
    /// Content-second ranges to silence. Nothing else in this plugin touches
    /// `isMuted`, so the gate owns it outright.
    var muteRanges: [(start: Double, end: Double)] = []
    var muteBoundaryObserver: Any?
    /// `allowsExternalPlayback` before the gate disabled it (nil = not engaged).
    var externalPlaybackBeforeMute: Bool?
    var statusObserver: NSKeyValueObservation?
    var timeControlObserver: NSKeyValueObservation?
    var firstFrameObserver: NSKeyValueObservation?
    var presentationSizeObserver: NSKeyValueObservation?
    var externalPlaybackObserver: NSKeyValueObservation?
    var externalPlaybackActive = false
    enum PipPhase { case inactive, active, exiting }
    var pipPhase = PipPhase.inactive
    /// Language the item opens on, set by `configure` before `load`; empty means the container's default.
    var preferredAudioLanguage = ""
    /// The party voice chat holds the microphone: the session must record and play.
    var voiceActive = false
    var resumeAfterSessionSwitch = false
    let heartbeat = PositionHeartbeat()
    var subtitleSelectionGeneration = 0
    var firstFrameEmitted = false
    var fillScreen = false
    var videoCrop: VideoCrop?
    var savedBrightness: CGFloat?
    /// Cues are pulled off the legible track with player rendering suppressed and drawn by `subtitleOverlay`;
    /// `applySubtitleRendering` decides when PiP lifts that, so the native track draws into the mirrored layer.
    var subtitleOutput: AVPlayerItemLegibleOutput?
    var subtitleOverlay: SubtitleOverlayView?
    var currentSubtitleStyle = SubtitleStyle()
    let legibleQueue = DispatchQueue(label: "fliks.subtitle.legible")
    /// Legible option deselected to clear the native caption while leaving PiP,
    /// restored once PiP has fully exited.
    var pipDeselectedSubtitle: AVMediaSelectionOption?
    /// Selection groups for the current item, loaded asynchronously once it is ready
    /// (the synchronous asset accessor is gone since iOS 16) so call sites stay synchronous.
    var audibleGroup: AVMediaSelectionGroup?
    var legibleGroup: AVMediaSelectionGroup?
    lazy var nowPlaying = NowPlayingController(
        emitEvent: { [weak self] name in self?.emitWindowEvent(name) },
        didSeek: { [weak self] in self?.emitTimeUpdate() }
    )

    /// Exposed for PipPlugin to access the player layer.
    public var activePlayerLayer: AVPlayerLayer? { playerLayer }
    /// Exposed for PipPlugin to access the player.
    public var activePlayer: AVPlayer? { player }

    /// Re-presents the AVPlayerLayer after a background round-trip or PiP exit, when iOS can release its
    /// render surface and the video returns black: rebind, re-stamp the frame, toggle videoGravity. Idempotent.
    func reassertVideoPresentation() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self,
                  let layer = self.playerLayer,
                  let player = self.player,
                  let view = self.playerView else { return }
            // Diagnostic: tells a detached or not-ready returning layer from a ready-but-black one.
            let state = "ready=\(layer.isReadyForDisplay) attached=\(layer.player != nil) size=\(Int(view.bounds.width))x\(Int(view.bounds.height))"
            self.bridge?.webView?.evaluateJavaScript("console.warn('[NativePlayer] reassert: \(state)');")

            if layer.player !== player { layer.player = player }
            self.layoutVideoLayer()
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
            view.clipsToBounds = true
            view.onLayout = { [weak self] in self?.layoutVideoLayer() }

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
            self.applySubtitleRendering()

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
            guard let self = self, let view = self.playerView else {
                call.resolve()
                return
            }
            // -1 follows the WebView's parent again, rotations included; a rectangle is the player container in CSS points.
            if width < 0 || height < 0 {
                view.frame = view.superview?.bounds ?? UIScreen.main.bounds
                view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            } else {
                view.autoresizingMask = []
                let origin = self.bridge?.webView?.frame.origin ?? .zero
                view.frame = CGRect(x: origin.x + CGFloat(x), y: origin.y + CGFloat(y), width: CGFloat(width), height: CGFloat(height))
            }
            self.layoutVideoLayer()
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
        let backgroundAudio = call.getBool("backgroundAudio") ?? false
        let title = call.getString("title") ?? ""
        let artist = call.getString("artist")
        let artworkUrl = call.getString("artworkUrl")

        logLoad(urlString: urlString, startTime: startTime)
        dumpManifestForDebug(url: url, headers: headers)

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.removeObservers()
            self.videoCrop = nil
            self.firstFrameEmitted = false
            self.player?.pause()
            self.subtitleOverlay?.render([])

            // Reassert `.playback` on every load: a call, route change or Siri can flip the session out of it,
            // and AVPlayer would start muted or downmixed.
            self.ensureAudioSessionActive()

            let item = self.buildPlayerItem(url: url, assetHeaders: headers)
            let player = self.attachPlayerItem(item)
            self.setupObservers()
            self.startPlayback(player: player, startTime: startTime)

            // `.automatic` rather than `.pauses`: an explicit pause-on-background policy
            // is not documented as exempting auto-PiP from inline.
            player.audiovisualBackgroundPlaybackPolicy = backgroundAudio ? .continuesIfPossible : .automatic
            if backgroundAudio {
                self.nowPlaying.activate(
                    player: player,
                    title: title,
                    artist: artist,
                    artworkUrl: artworkUrl,
                    headers: headers,
                    streamHost: url.host
                )
            } else {
                self.nowPlaying.deactivate(releaseSession: false)
            }

            call.resolve()
        }
    }

    func parseHeaders(_ raw: [String: Any]?) -> [String: String] {
        var out: [String: String] = [:]
        for (key, value) in raw ?? [:] {
            if let str = value as? String { out[key] = str }
        }
        return out
    }

    func logLoad(urlString: String, startTime: Double) {
        let safeUrl = urlString.replacingOccurrences(of: "'", with: "\\'")
        let js = "console.warn('[NativePlayer] load', '\(safeUrl)', 'startTime=\(startTime)');"
        DispatchQueue.main.async { [weak self] in
            self?.bridge?.webView?.evaluateJavaScript(js)
        }
    }

    /// Debug-only manifest dump (CODECS, BANDWIDTH, VIDEO-RANGE) to reproduce a `-12927` with an empty
    /// `errorLog`; skipped in release, the extra fetch adds up to 3s of cellular latency.
    func dumpManifestForDebug(url: URL, headers: [String: String]) {
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

    func ensureAudioSessionActive() {
        let session = AVAudioSession.sharedInstance()
        do {
            // Voice chat: WebKit's getUserMedia needs a recording category, and `.playback` would cut the mic.
            if voiceActive {
                if session.category != .playAndRecord {
                    try session.setCategory(
                        .playAndRecord,
                        mode: .default,
                        options: [.defaultToSpeaker, .allowBluetoothA2DP, .allowAirPlay]
                    )
                }
            } else if session.category != .playback {
                try session.setCategory(
                    .playback,
                    mode: .moviePlayback,
                    options: [.allowAirPlay, .allowBluetoothA2DP]
                )
            }
            try session.setActive(true)
        } catch {
            // Best effort: degraded audio beats a hard load failure.
        }
    }

    @objc func setVoiceActive(_ call: CAPPluginCall) {
        let active = call.getBool("active") ?? false
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.voiceActive = active
            guard let player = self.player else { call.resolve(); return }
            let wasPlaying = player.timeControlStatus != .paused
            self.resumeAfterSessionSwitch = wasPlaying
            self.ensureAudioSessionActive()
            call.resolve()
            // The category switch can interrupt AVPlayer asynchronously; an app pause clears the flag.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                guard let self = self, self.resumeAfterSessionSwitch else { return }
                self.resumeAfterSessionSwitch = false
                if self.player?.timeControlStatus == .paused { self.ensureAudioSessionActive(); self.player?.play() }
            }
        }
    }

    @objc func setVolume(_ call: CAPPluginCall) {
        let volume = Float(min(max(call.getDouble("volume") ?? 1, 0), 1))
        DispatchQueue.main.async { [weak self] in
            self?.player?.volume = volume
            call.resolve()
        }
    }

    @objc func configure(_ call: CAPPluginCall) {
        preferredAudioLanguage = call.getString("preferredAudioLanguage") ?? ""
        call.resolve()
    }

    @objc func setHeartbeat(_ call: CAPPluginCall) {
        guard let url = call.getString("url"), let token = call.getString("token"),
              let body = call.getObject("body") else {
            call.reject("url, token and body are required")
            return
        }
        DispatchQueue.main.async { [weak self] in
            self?.heartbeat.set(url: url, token: token, body: body as [String: Any])
            call.resolve()
        }
    }

    /// 4-second forward buffer hint (about one HLS segment plus margin): without it AVPlayer can start audio
    /// decode while video still resolves its first IDR, and sound plays over a black frame.
    func buildPlayerItem(url: URL, assetHeaders: [String: String]) -> AVPlayerItem {
        let assetOptions: [String: Any]? = assetHeaders.isEmpty
            ? nil
            : ["AVURLAssetHTTPHeaderFieldsKey": assetHeaders]
        let asset = AVURLAsset(url: url, options: assetOptions)
        if #available(iOS 18.0, *) { asset.resourceLoader.sendsCommonMediaClientDataAsHTTPHeaders = true }
        // Preload `playable`/`tracks`/`duration` so `.readyToPlay` fires
        // without a second round-trip after the asset header arrives.
        let item = AVPlayerItem(
            asset: asset,
            automaticallyLoadedAssetKeys: ["playable", "tracks", "duration"]
        )
        item.preferredForwardBufferDuration = 4
        return item
    }

    /// Reuses the existing AVPlayer via `replaceCurrentItem` (observers, audio session and PiP stay wired), else creates one.
    /// No initial bitrate cap: it rejected the single-variant HDR manifest (-12927); `setMaxResolution` caps on an explicit pick.
    @discardableResult
    func attachPlayerItem(_ item: AVPlayerItem) -> AVPlayer {
        // Groups belong to the outgoing asset — selecting one of its options
        // on the new item would raise.
        audibleGroup = nil
        legibleGroup = nil
        pipDeselectedSubtitle = nil
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
        defer { syncExternalPlaybackForMute() }
        // A mirrored screen hands the video to the receiver full screen
        // instead of mirroring the app UI around it.
        player.usesExternalPlaybackWhileExternalScreenIsActive = true
        self.player = player
        if playerLayer == nil, let view = playerView {
            let layer = AVPlayerLayer(player: player)
            layer.videoGravity = .resizeAspect
            // Index 0 keeps the video beneath the subtitle overlay subview.
            view.layer.insertSublayer(layer, at: 0)
            playerLayer = layer
            layoutVideoLayer()
            (bridge?.plugin(withName: "Pip") as? PipPlugin)?.playerLayerDidChange()
        } else {
            playerLayer?.player = player
        }
        return player
    }

    /// Frame-accurate seek (`.zero` tolerance) then `play()`: the default tolerance snaps audio and video to different
    /// keyframes, a 0-3 s A/V desync. `play()` stays outside the completion handler, which may report `finished=false`.
    func startPlayback(player: AVPlayer, startTime: Double) {
        if startTime > 0 {
            applyMuteGate(at: startTime)
            let cmTime = CMTime(seconds: startTime, preferredTimescale: 1000)
            player.seek(to: cmTime, toleranceBefore: .zero, toleranceAfter: .zero)
        }
        player.play()
    }

    @objc func play(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            // An interruption or the voice switch can leave the session inactive, and play() then does nothing.
            self?.ensureAudioSessionActive()
            self?.player?.play()
            call.resolve()
        }
    }

    @objc func pause(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.resumeAfterSessionSwitch = false
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
            self?.applyMuteGate(at: position)
            // Resolve only after the seek finishes: resolving early let a mid-seek `currentTime()` (often 0) snap the
            // seekbar back before AVPlayer settled. The completion fires even when the seek is pre-empted.
            player.seek(
                to: cmTime,
                toleranceBefore: .zero,
                toleranceAfter: .zero
            ) { _ in
                DispatchQueue.main.async {
                    self?.nowPlaying.refresh()
                    self?.applyMuteGate(at: player.currentTime().seconds)
                    self?.emitTimeUpdate()
                }
                call.resolve()
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.player?.pause()
            self?.player?.replaceCurrentItem(with: nil)
            self?.subtitleOverlay?.render([])
            self?.videoCrop = nil
            self?.layoutVideoLayer()
            self?.audibleGroup = nil
            self?.legibleGroup = nil
            // Session and controls stay up: a load follows an episode or quality switch,
            // and dropping the session mid-switch would let a locked app be suspended.
            self?.nowPlaying.refresh()
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
            // Surface the selected state: an AVPlayer media-selection change emits no event of its own.
            self?.emitTracksChanged()
            call.resolve()
        }
    }

    // MARK: - Subtitle Tracks

    @objc func getSubtitleTracks(_ call: CAPPluginCall) {
        Task { @MainActor [weak self] in
            let group = await self?.loadedLegibleGroup()
            call.resolve(["tracks": group.map(Self.subtitleTracks) ?? []])
        }
    }

    /// Subtitle rows for JS. displayName == the manifest NAME (the rendition's
    /// stable id); the engine matches the picked track by it.
    static func subtitleTracks(_ group: AVMediaSelectionGroup) -> [[String: Any]] {
        group.options.enumerated().map { index, option in
            let locale = option.locale ?? Locale(identifier: "und")
            return [
                "id": "text-\(index)",
                "language": locale.language.languageCode?.identifier ?? "und",
                "label": option.displayName,
                "forced": option.hasMediaCharacteristic(.containsOnlyForcedSubtitles),
            ]
        }
    }

    /// The cached legible group, re-read from the asset while empty: `.readyToPlay` can settle before the
    /// asset lists its options and nothing else refills the cache for that item.
    @MainActor
    func loadedLegibleGroup() async -> AVMediaSelectionGroup? {
        if let group = legibleGroup, !group.options.isEmpty { return group }
        guard let item = player?.currentItem else { return nil }
        let group = try? await item.asset.loadMediaSelectionGroup(for: .legible)
        guard player?.currentItem === item else { return nil }
        if let group = group { legibleGroup = group }
        return group
    }

    @objc func selectSubtitleTrack(_ call: CAPPluginCall) {
        let id = call.getString("id")

        Task { @MainActor [weak self] in
            self?.subtitleSelectionGeneration += 1
            let generation = self?.subtitleSelectionGeneration
            let loaded = await self?.loadedLegibleGroup()
            guard generation == self?.subtitleSelectionGeneration,
                  let group = loaded,
                  let item = self?.player?.currentItem else {
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
            bottomMarginPercent: CGFloat(call.getFloat("bottomMarginPercent") ?? 8.0),
            topMarginPercent: CGFloat(call.getFloat("topMarginPercent") ?? 5.0)
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

    /// Attaches a legible output with player rendering suppressed: cues go to the delegate and `subtitleOverlay`.
    /// `.sourceAndRulesOnly` keeps the system's boxed caption styling out of them.
    func attachLegibleOutput(to item: AVPlayerItem) {
        let output = AVPlayerItemLegibleOutput()
        output.textStylingResolution = .sourceAndRulesOnly
        output.setDelegate(self, queue: legibleQueue)
        item.add(output)
        subtitleOutput = output
        applySubtitleRendering()
    }

    /// AVPlayer draws the native (boxed) caption where the overlay can't be seen: AirPlay receiver and PiP window.
    /// Otherwise the overlay draws, hidden through the PiP exit animation.
    func applySubtitleRendering() {
        let native = externalPlaybackActive || pipPhase == .active
        subtitleOutput?.suppressesPlayerRendering = !native
        subtitleOverlay?.isHidden = native || pipPhase == .exiting
        if native { subtitleOverlay?.render([]) }
        player?.currentItem?.textStyleRules = pipPhase == .active ? Self.pipTextStyleRules : nil
    }

    /// The PiP window is a fraction of the screen, so the default native caption size reads small in it.
    /// Rules also style the overlay's cues, so they apply only while PiP draws the native caption.
    private static let pipTextStyleRules: [AVTextStyleRule] = [
        AVTextStyleRule(textMarkupAttributes: [kCMTextMarkupAttribute_RelativeFontSize as String: 200]),
    ].compactMap { $0 }

    /// PiP mirrors the AVPlayerLayer, not the overlay. Will-stop also clears the native caption;
    /// the overlay is revealed once PiP has fully exited (`finishSubtitlePiPExit`).
    public func setSubtitleRenderingForPiP(_ inPiP: Bool) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.pipPhase = inPiP ? .active : .exiting
            self.applySubtitleRendering()
            if !inPiP { self.clearNativeCaption() }
        }
    }

    /// Called once PiP has fully stopped (after the restore animation). Restores
    /// the legible cue flow to the output and reveals the no-box overlay.
    public func finishSubtitlePiPExit() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.restoreLegibleSelection()
            self.pipPhase = .inactive
            self.applySubtitleRendering()
        }
    }

    /// Deselects the legible option to drop the caption rendered during PiP (re-suppressing leaves the last cue
    /// frozen); the option is remembered to restore cue delivery on exit.
    func clearNativeCaption() {
        guard let item = player?.currentItem,
              let group = legibleGroup else { return }
        pipDeselectedSubtitle = item.currentMediaSelection.selectedMediaOption(in: group)
        item.select(nil, in: group)
    }

    func restoreLegibleSelection() {
        guard let option = pipDeselectedSubtitle,
              let item = player?.currentItem,
              let group = legibleGroup else { return }
        item.select(option, in: group)
        pipDeselectedSubtitle = nil
    }

    /// The overlay is a phone subview a receiver never sees, so AVPlayer renders the native caption over AirPlay.
    /// Emits on every call; only a change touches the subtitle state, which PiP also drives.
    func setExternalPlayback(_ active: Bool) {
        defer { emitExternalPlayback(active) }
        guard active != externalPlaybackActive else { return }
        externalPlaybackActive = active
        applySubtitleRendering()
    }

    func emitExternalPlayback(_ active: Bool) {
        let js = "window.dispatchEvent(new CustomEvent('nativePlayerExternalPlaybackChanged', { detail: { active: \(active) } }));"
        bridge?.webView?.evaluateJavaScript(js)
    }

    // MARK: - Mute ranges

    @objc func setMuteRanges(_ call: CAPPluginCall) {
        let raw = call.getArray("ranges", JSObject.self) ?? []
        let ranges = raw.compactMap { r -> (start: Double, end: Double)? in
            guard let s = r["start"] as? Double ?? (r["start"] as? Int).map(Double.init),
                  let e = r["end"] as? Double ?? (r["end"] as? Int).map(Double.init),
                  s.isFinite, e.isFinite, e > s else { return nil }
            return (s, e)
        }
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.muteRanges = ranges
            self.installMuteBoundaries()
            self.syncExternalPlaybackForMute()
            call.resolve()
        }
    }

    /// Muted on [start - lead, end): the observer fires at or after its boundary, so the
    /// lead keeps the start from being late and the end can only be late, never early.
    static let muteLead = 0.05

    func inMuteRange(_ t: Double) -> Bool {
        muteRanges.contains { t >= $0.start - Self.muteLead && t < $0.end }
    }

    func applyMuteGate(at position: Double) {
        guard let player = player else { return }
        player.isMuted = position.isFinite && inMuteRange(position)
    }

    func installMuteBoundaries() {
        removeMuteBoundaries()
        guard let player = player else { return }
        if muteRanges.isEmpty {
            player.isMuted = false
            return
        }
        let times = muteRanges.flatMap { [max(0, $0.start - Self.muteLead), $0.end] }
            .map { NSValue(time: CMTime(seconds: $0, preferredTimescale: 1000)) }
        muteBoundaryObserver = player.addBoundaryTimeObserver(forTimes: times, queue: .main) { [weak self] in
            guard let self = self, let p = self.player else { return }
            self.applyMuteGate(at: p.currentTime().seconds)
        }
        applyMuteGate(at: player.currentTime().seconds)
    }

    func removeMuteBoundaries() {
        if let obs = muteBoundaryObserver {
            player?.removeTimeObserver(obs)
            muteBoundaryObserver = nil
        }
    }

    /// `isMuted` may not reach an AirPlay video receiver, so the video stays on
    /// the phone while ranges exist; the previous setting returns once cleared.
    func syncExternalPlaybackForMute() {
        guard let player = player else { return }
        if muteRanges.isEmpty {
            if let prev = externalPlaybackBeforeMute {
                player.allowsExternalPlayback = prev
                externalPlaybackBeforeMute = nil
            }
        } else if externalPlaybackBeforeMute == nil {
            externalPlaybackBeforeMute = player.allowsExternalPlayback
            player.allowsExternalPlayback = false
        }
    }

    // MARK: - Brightness

    // MARK: - Display

    /// Crop-to-fill vs letterbox. `resizeAspectFill` is the AVPlayerLayer
    /// equivalent of `object-fit: cover` — the layer clips the overflow itself.
    @objc func setFillScreen(_ call: CAPPluginCall) {
        let fill = call.getBool("fill") ?? false

        DispatchQueue.main.async { [weak self] in
            self?.fillScreen = fill
            self?.layoutVideoLayer()
            call.resolve()
        }
    }

    /// Crops letterbox bars by sizing the layer past the clipping container.
    /// An absent or non-positive rectangle clears the crop.
    @objc func setCrop(_ call: CAPPluginCall) {
        var crop: VideoCrop?
        if let w = call.getDouble("width"), let h = call.getDouble("height"),
           let sw = call.getDouble("sourceWidth"), let sh = call.getDouble("sourceHeight"),
           w > 0, h > 0, sw > 0, sh > 0 {
            crop = VideoCrop(
                x: CGFloat(call.getDouble("x") ?? 0),
                y: CGFloat(call.getDouble("y") ?? 0),
                width: CGFloat(w),
                height: CGFloat(h),
                sourceWidth: CGFloat(sw),
                sourceHeight: CGFloat(sh)
            )
        }
        DispatchQueue.main.async { [weak self] in
            self?.videoCrop = crop
            self?.layoutVideoLayer()
            call.resolve()
        }
    }

    /// The layer follows the container unless a crop applies, in which case its
    /// frame is computed exactly so `.resizeAspect` adds no bars of its own.
    func layoutVideoLayer() {
        guard let layer = playerLayer, let view = playerView else { return }
        let display = player?.currentItem?.presentationSize
        let cropped = VideoCropLayout.layerFrame(
            container: view.bounds.size, crop: videoCrop, display: display, fill: fillScreen
        )
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if let frame = cropped {
            layer.videoGravity = .resizeAspect
            layer.frame = frame
        } else {
            layer.videoGravity = fillScreen ? .resizeAspectFill : .resizeAspect
            layer.frame = view.bounds
        }
        CATransaction.commit()
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
                // AVPlayer HLS has no ABR off switch: a tight resolution cap plus a peak-bitrate ceiling just above the
                // target profile pins that rung and blocks upward switches; downward switching under congestion remains.
                item.preferredMaximumResolution = CGSize(width: width, height: height)
                item.preferredPeakBitRate = Self.peakBitRateForHeight(height)
            }
            call.resolve()
        }
    }

    /// Peak bitrate ceiling (bps) just above the transcode profile for the target height, pinning that rung.
    /// Mirrors backend PROFILES in transcoding.service.ts: update both.
    static func peakBitRateForHeight(_ height: Int) -> Double {
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

    /// Playback-quality counters for the current item (its access log restarts with each item).
    @objc func getQoe(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let item = self.player?.currentItem else { return call.resolve(self?.qoe(nil, ahead: nil) ?? [:]) }
            let t = item.currentTime().seconds
            let ahead = item.loadedTimeRanges.map(\.timeRangeValue)
                .first { $0.containsTime(item.currentTime()) }
                .map { CMTimeGetSeconds($0.end) - t }
            call.resolve(self.qoe(item, ahead: ahead))
        }
    }

    /// Frame rate and codec of the enabled video track; HLS exposes the live rate only on the item track.
    static func videoTrackInfo(_ item: AVPlayerItem?) -> (fps: Double?, codec: String?) {
        guard let track = item?.tracks.first(where: { $0.isEnabled && $0.assetTrack?.mediaType == .video }) else {
            return (nil, nil)
        }
        let live = Double(track.currentVideoFrameRate)
        let nominal = Double(track.assetTrack?.nominalFrameRate ?? 0)
        let fps = live > 0 ? live : (nominal > 0 ? nominal : nil)
        var codec: String?
        if let fd = track.assetTrack?.formatDescriptions.first {
            let code = CMFormatDescriptionGetMediaSubType(fd as! CMFormatDescription)
            let chars = (0..<4).map { UInt8((code >> UInt32(24 - 8 * $0)) & 0xff) }
            codec = String(bytes: chars, encoding: .ascii)
        }
        return (fps, codec)
    }

    var decodedEstimate = DecodedEstimate()

    func qoe(_ item: AVPlayerItem?, ahead: Double?) -> [String: Any] {
        let events = item?.accessLog()?.events ?? []
        let last = events.last
        let dropped = events.map(\.numberOfDroppedVideoFrames).filter { $0 >= 0 }.reduce(0, +)
        let size = item?.presentationSize ?? .zero
        let video = Self.videoTrackInfo(item)
        // AVPlayer has no decoded-frame counter: estimated from watched time and frame rate.
        let watched = events.map(\.durationWatched).filter { $0 > 0 }.reduce(0, +)
        let decoded = decodedEstimate.update(item: item, watched: watched, fps: video.fps)
        func pos(_ v: Double?) -> Any { v.flatMap { $0 > 0 ? $0 : nil } ?? NSNull() }
        var cmcd = false
        if #available(iOS 18.0, *) { cmcd = true }
        return [
            "engine": "avplayer",
            "cmcd": cmcd,
            "droppedFrames": events.isEmpty ? NSNull() : dropped,
            "decodedFrames": decoded ?? NSNull(),
            "bandwidthBps": pos(last?.observedBitrate),
            "bufferAheadS": ahead.map { max($0, 0) } ?? NSNull(),
            "variantBitrate": pos(last?.indicatedBitrate),
            "width": size.width > 0 ? Int(size.width) : NSNull(),
            "height": size.height > 0 ? Int(size.height) : NSNull(),
            "videoCodec": video.codec ?? NSNull(),
            "decoderName": NSNull(),
            "hwDecoder": NSNull(),
        ]
    }

    @objc func setPlaybackRate(_ call: CAPPluginCall) {
        let rate = call.getFloat("rate") ?? 1.0
        DispatchQueue.main.async { [weak self] in
            if let player = self?.player {
                // play() restarts at defaultRate; a rate write while paused would start playback.
                player.defaultRate = rate
                if player.timeControlStatus != .paused { player.rate = rate }
            }
            self?.nowPlaying.refresh()
            call.resolve()
        }
    }

    @objc func setQueueNav(_ call: CAPPluginCall) {
        let hasPrevious = call.getBool("hasPrevious") ?? false
        let hasNext = call.getBool("hasNext") ?? false
        let seekButtons = call.getBool("seekButtons") ?? false
        DispatchQueue.main.async { [weak self] in
            self?.nowPlaying.setQueueNav(hasPrevious: hasPrevious, hasNext: hasNext, seekButtons: seekButtons)
            call.resolve()
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
        // A WebVTT `line:` setting (`{\an8}` upstream) arrives as this percentage.
        let lineKey = NSAttributedString.Key(kCMTextMarkupAttribute_OrthogonalLinePositionPercentageRelativeToWritingDirection as String)
        let top = strings.contains { s in
            s.length > 0 && ((s.attribute(lineKey, at: 0, effectiveRange: nil) as? NSNumber)?.doubleValue ?? 100) < 40
        }
        DispatchQueue.main.async { [weak self] in
            self?.subtitleOverlay?.render(cues, top: top)
        }
    }
}
