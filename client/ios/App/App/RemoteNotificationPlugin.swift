import AVFoundation
import Capacitor
import MediaPlayer

/// Lock screen / Control Center for the device this phone remote-controls, and its hardware volume keys.
/// A silent loop holds the audio session: iOS lists an app in Now Playing only while it plays audio,
/// which needs a non-mixable session. The loop is released after `pausedLimit` of a paused target.
/// Controls go back as `remoteNotificationCommand` window events: {action, value}.
@objc(RemoteNotificationPlugin)
public class RemoteNotificationPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RemoteNotificationPlugin"
    public let jsName = "RemoteNotification"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
    ]

    private static let volumeStep = 0.05
    private static let pinnedLevel: Float = 0.5
    private static let pausedLimit: TimeInterval = 600
    private static let stopGrace: TimeInterval = 8

    private var silence: AVAudioPlayer?
    private var targets: [(command: MPRemoteCommand, token: Any)] = []
    private var observers: [NSObjectProtocol] = []
    private var volumeObservation: NSKeyValueObservation?
    private var volumeView: MPVolumeView?
    private var restoreVolume: Float?
    private var pinning = false
    private var pausedTimer: Timer?
    /// The paused title whose lock screen was released: its reports stay ignored until it plays or changes.
    private var releasedTitle: String?
    /// Set when another app took the session, cleared when iOS says to resume or the target is started again:
    /// meanwhile the loop never cuts that app off and the volume keys stay its own.
    private var interrupted = false
    private var seekedAt = Date.distantPast
    private var canSetVolume = false
    private var volume = 1.0
    private var artworkUrl: String?
    private var artwork: MPMediaItemArtwork?
    private var title = ""
    private var artist: String?
    private var duration = 0.0
    private var playing = false
    private var advancing = false
    private var reportedPosition = 0.0
    private var reportedAt = Date()

    @objc func update(_ call: CAPPluginCall) {
        let title = call.getString("title") ?? ""
        let artist = call.getString("artist")
        let url = call.getString("artworkUrl")
        let playing = call.getBool("playing") ?? false
        let buffering = call.getBool("buffering") ?? false
        let position = call.getDouble("position") ?? 0
        let duration = call.getDouble("duration") ?? 0
        let hasNext = call.getBool("hasNext") ?? false
        let seekButtons = call.getBool("seekButtons") ?? false
        let canSetVolume = call.getBool("canSetVolume") ?? false
        let volume = call.getDouble("volume") ?? 1
        let sentAt = Date(timeIntervalSince1970: (call.getDouble("sentAt") ?? 0) / 1000)
        DispatchQueue.main.async {
            if !playing && title == self.releasedTitle {
                call.resolve()
                return
            }
            self.releasedTitle = nil
            self.canSetVolume = canSetVolume
            self.volume = volume
            self.title = title
            self.artist = artist
            self.duration = duration
            // The user restarting a paused target takes the session back from the app that interrupted it.
            if playing && !self.playing { self.interrupted = false }
            self.playing = playing
            self.advancing = playing && !buffering
            // A report sent before the last local seek still carries the old position.
            if sentAt >= self.seekedAt {
                self.reportedPosition = max(position, 0)
                self.reportedAt = Date()
            }
            self.start()
            if url != self.artworkUrl {
                self.artworkUrl = url
                self.artwork = nil
                self.loadArtwork(url)
            }
            self.publish()
            self.applyCommands(hasNext: hasNext, seekButtons: seekButtons)
            self.syncVolumePin()
            self.schedulePausedLimit()
            call.resolve()
        }
    }

    @objc func clear(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.releasedTitle = nil
            self.stop()
            call.resolve()
        }
    }

    override public func load() {
        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: UIApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
                self?.stop()
            },
            center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
                self?.interruption(note)
            },
            center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
                guard let self, self.silence != nil else { return }
                self.silence = nil
                self.start()
            },
        ]
    }

    // MARK: - Session

    private func start() {
        guard silence?.isPlaying != true, !interrupted else { return }
        startLoop()
        guard silence?.isPlaying == true else { return }
        if targets.isEmpty { installCommands() }
        if volumeObservation == nil {
            volumeObservation = AVAudioSession.sharedInstance().observe(\.outputVolume, options: [.new]) { [weak self] _, change in
                guard let level = change.newValue else { return }
                DispatchQueue.main.async { self?.systemVolumeChanged(level) }
            }
        }
    }

    /// Keeps the player across a failed restart: the next report retries, so a player that is not playing is never taken for a running loop.
    private func startLoop() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .moviePlayback)
        try? session.setActive(true)
        if silence == nil, let player = try? AVAudioPlayer(data: Self.silentWav) {
            player.numberOfLoops = -1
            silence = player
        }
        silence?.play()
    }

    private func interruption(_ note: Notification) {
        guard silence != nil,
              let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        switch type {
        case .began:
            interrupted = true
            volumeObservation = nil
            syncVolumePin()
        case .ended:
            let options = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            guard AVAudioSession.InterruptionOptions(rawValue: options).contains(.shouldResume) else { return }
            interrupted = false
            start()
            syncVolumePin()
        @unknown default:
            break
        }
    }

    private func stop() {
        pausedTimer?.invalidate()
        pausedTimer = nil
        guard silence != nil || !targets.isEmpty else { return }
        interrupted = false
        silence?.stop()
        silence = nil
        volumeObservation = nil
        pinVolume(false)
        for entry in targets { entry.command.removeTarget(entry.token) }
        targets.removeAll()
        // Another player may have taken the lock screen since: leave what is not ours.
        let center = MPNowPlayingInfoCenter.default()
        if center.nowPlayingInfo?[MPMediaItemPropertyTitle] as? String == title {
            for command in managed(MPRemoteCommandCenter.shared()) { command.isEnabled = false }
            center.nowPlayingInfo = nil
            center.playbackState = .stopped
        }
        artworkUrl = nil
        artwork = nil
        // Fails while another player holds the session, which is the wanted outcome.
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// Armed once per pause: a paused target keeps reporting, and a report must not push the release back.
    private func schedulePausedLimit() {
        guard !playing else {
            pausedTimer?.invalidate()
            pausedTimer = nil
            return
        }
        guard pausedTimer == nil else { return }
        pausedTimer = Timer.scheduledTimer(withTimeInterval: Self.pausedLimit, repeats: false) { [weak self] _ in
            guard let self else { return }
            self.releasedTitle = self.title
            self.stop()
        }
    }

    // MARK: - Volume

    /// The system level is pinned mid-range while a target takes the keys: each press moves it off the pin,
    /// becomes one step on the target and is put back, so the keys never hit a bound. The old level returns after.
    private func pinVolume(_ on: Bool) {
        guard on != pinning else { return }
        pinning = on
        if on {
            restoreVolume = AVAudioSession.sharedInstance().outputVolume
            let view = MPVolumeView(frame: CGRect(x: -2000, y: -2000, width: 1, height: 1))
            (bridge?.viewController?.view).map { $0.addSubview(view) }
            volumeView = view
            setSystemVolume(Self.pinnedLevel)
        } else {
            // Synchronous: the main queue may never run again once the app is terminating.
            if let level = restoreVolume { volumeView?.subviews.compactMap { $0 as? UISlider }.first?.value = level }
            restoreVolume = nil
            let view = volumeView
            volumeView = nil
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { view?.removeFromSuperview() }
        }
    }

    private func syncVolumePin() {
        pinVolume(canSetVolume && !interrupted)
    }

    private func setSystemVolume(_ level: Float) {
        let slider = volumeView?.subviews.compactMap { $0 as? UISlider }.first
        // The slider only accepts a value once laid out; a release since then has restored the level.
        DispatchQueue.main.async { if self.pinning { slider?.value = level } }
    }

    private func systemVolumeChanged(_ level: Float) {
        guard pinning, canSetVolume, abs(level - Self.pinnedLevel) > 0.01 else { return }
        let next = min(max(volume + (level > Self.pinnedLevel ? Self.volumeStep : -Self.volumeStep), 0), 1)
        volume = next
        emit("volume", next)
        setSystemVolume(Self.pinnedLevel)
    }

    // MARK: - Now playing

    /// The report's position moved on by the time since it, while the target plays.
    private func elapsed() -> Double {
        let value = reportedPosition + (advancing ? Date().timeIntervalSince(reportedAt) : 0)
        return duration > 0 ? min(value, duration) : value
    }

    /// A seek moves the base of the next skip, and reports sent before it no longer move that base.
    private func noteSeek(_ position: Double) {
        reportedPosition = position
        reportedAt = Date()
        seekedAt = reportedAt
    }

    private func publish() {
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: title,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.video.rawValue,
            MPNowPlayingInfoPropertyPlaybackRate: advancing ? 1.0 : 0.0,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: elapsed(),
        ]
        if let artist { info[MPMediaItemPropertyArtist] = artist }
        if duration > 0 { info[MPMediaItemPropertyPlaybackDuration] = duration }
        if let artwork { info[MPMediaItemPropertyArtwork] = artwork }
        let center = MPNowPlayingInfoCenter.default()
        center.nowPlayingInfo = info
        center.playbackState = playing ? .playing : .paused
    }

    private func loadArtwork(_ urlString: String?) {
        guard let urlString, let url = URL(string: urlString) else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let data, let image = UIImage(data: data) else { return }
            let artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
            DispatchQueue.main.async {
                guard let self, self.artworkUrl == urlString, self.silence != nil else { return }
                self.artwork = artwork
                self.publish()
            }
        }.resume()
    }

    // MARK: - Commands

    private func managed(_ center: MPRemoteCommandCenter) -> [MPRemoteCommand] {
        [
            center.playCommand, center.pauseCommand, center.togglePlayPauseCommand,
            center.changePlaybackPositionCommand, center.skipBackwardCommand, center.skipForwardCommand,
            center.nextTrackCommand, center.previousTrackCommand, center.stopCommand,
        ]
    }

    private func add(_ command: MPRemoteCommand, _ handler: @escaping (MPRemoteCommandEvent) -> MPRemoteCommandHandlerStatus) {
        targets.append((command, command.addTarget(handler: handler)))
    }

    private func installCommands() {
        let center = MPRemoteCommandCenter.shared()
        let send: (String, Double) -> MPRemoteCommandHandlerStatus = { [weak self] action, value in
            self?.emit(action, value)
            return .success
        }
        add(center.playCommand) { _ in send("play", 0) }
        add(center.pauseCommand) { _ in send("pause", 0) }
        add(center.togglePlayPauseCommand) { [weak self] _ in send(self?.playing == true ? "pause" : "play", 0) }
        add(center.stopCommand) { [weak self] _ in
            // Keeps the app running long enough for the stop to reach the target once the audio is gone.
            self?.holdForStop()
            let status = send("stop", 0)
            self?.stop()
            return status
        }
        add(center.nextTrackCommand) { _ in send("next", 0) }
        add(center.previousTrackCommand) { [weak self] _ in
            self?.noteSeek(0)
            return send("seek", 0)
        }
        add(center.changePlaybackPositionCommand) { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            self?.noteSeek(event.positionTime)
            return send("seek", event.positionTime)
        }
        for (command, sign) in [(center.skipBackwardCommand, -1.0), (center.skipForwardCommand, 1.0)] {
            add(command) { [weak self] event in
                guard let self, let event = event as? MPSkipIntervalCommandEvent else { return .commandFailed }
                let target = max(self.elapsed() + sign * event.interval, 0)
                self.noteSeek(target)
                return send("seek", target)
            }
        }
    }

    private func holdForStop() {
        var task = UIBackgroundTaskIdentifier.invalid
        let end = {
            guard task != .invalid else { return }
            UIApplication.shared.endBackgroundTask(task)
            task = .invalid
        }
        task = UIApplication.shared.beginBackgroundTask(expirationHandler: end)
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.stopGrace, execute: end)
    }

    private func applyCommands(hasNext: Bool, seekButtons: Bool) {
        let center = MPRemoteCommandCenter.shared()
        for command in [center.playCommand, center.pauseCommand, center.togglePlayPauseCommand,
                        center.changePlaybackPositionCommand, center.stopCommand] {
            command.isEnabled = true
        }
        center.skipBackwardCommand.preferredIntervals = [10]
        center.skipForwardCommand.preferredIntervals = [10]
        center.skipBackwardCommand.isEnabled = seekButtons
        center.skipForwardCommand.isEnabled = seekButtons
        center.nextTrackCommand.isEnabled = !seekButtons && hasNext
        center.previousTrackCommand.isEnabled = !seekButtons
    }

    private func emit(_ action: String, _ value: Double) {
        let detail = "{\"action\":\"\(action)\",\"value\":\(value)}"
        DispatchQueue.main.async {
            self.bridge?.webView?.evaluateJavaScript(
                "window.dispatchEvent(new CustomEvent('remoteNotificationCommand',{detail:\(detail)}));")
        }
    }

    /// One second of 8 kHz mono silence.
    private static let silentWav: Data = {
        let samples = 8000
        var d = Data()
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        d.append("RIFF".data(using: .ascii)!); u32(UInt32(36 + samples))
        d.append("WAVEfmt ".data(using: .ascii)!); u32(16); u16(1); u16(1); u32(8000); u32(8000); u16(1); u16(8)
        d.append("data".data(using: .ascii)!); u32(UInt32(samples))
        d.append(Data(repeating: 128, count: samples))
        return d
    }()
}
