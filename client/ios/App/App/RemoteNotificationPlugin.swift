import AVFoundation
import Capacitor
import MediaPlayer

/// Lock screen / Control Center for the device this phone remote-controls, and its hardware volume keys.
/// A silent loop holds the audio session: iOS lists an app in Now Playing only while it plays audio.
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

    private var silence: AVAudioPlayer?
    private var targets: [(command: MPRemoteCommand, token: Any)] = []
    private var volumeObservation: NSKeyValueObservation?
    private var lastSystemVolume: Float = 0
    private var canSetVolume = false
    private var volume = 1.0
    private var artworkUrl: String?
    private var artwork: MPMediaItemArtwork?
    private var info: [String: Any] = [:]

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
        DispatchQueue.main.async {
            self.canSetVolume = canSetVolume
            self.volume = volume
            self.start()
            var info: [String: Any] = [
                MPMediaItemPropertyTitle: title,
                MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.video.rawValue,
                MPNowPlayingInfoPropertyPlaybackRate: playing && !buffering ? 1.0 : 0.0,
                MPNowPlayingInfoPropertyElapsedPlaybackTime: max(position, 0),
            ]
            if let artist { info[MPMediaItemPropertyArtist] = artist }
            if duration > 0 { info[MPMediaItemPropertyPlaybackDuration] = duration }
            if url != self.artworkUrl {
                self.artworkUrl = url
                self.artwork = nil
                self.loadArtwork(url)
            }
            if let artwork = self.artwork { info[MPMediaItemPropertyArtwork] = artwork }
            self.info = info
            self.publish(playing: playing)
            self.applyCommands(hasNext: hasNext, seekButtons: seekButtons)
            call.resolve()
        }
    }

    @objc func clear(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.stop()
            call.resolve()
        }
    }

    override public func load() {
        NotificationCenter.default.addObserver(forName: UIApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
            self?.stop()
        }
    }

    // MARK: - Session

    private func start() {
        guard silence == nil else { return }
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .moviePlayback)
        try? session.setActive(true)
        guard let player = try? AVAudioPlayer(data: Self.silentWav) else { return }
        player.numberOfLoops = -1
        player.play()
        silence = player
        installCommands()
        lastSystemVolume = session.outputVolume
        volumeObservation = session.observe(\.outputVolume, options: [.new]) { [weak self] _, change in
            guard let level = change.newValue else { return }
            DispatchQueue.main.async { self?.systemVolumeChanged(level) }
        }
    }

    private func stop() {
        guard let player = silence else { return }
        player.stop()
        silence = nil
        volumeObservation = nil
        for entry in targets { entry.command.removeTarget(entry.token) }
        targets.removeAll()
        let center = MPRemoteCommandCenter.shared()
        for command in managed(center) { command.isEnabled = false }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        MPNowPlayingInfoCenter.default().playbackState = .stopped
        artworkUrl = nil
        artwork = nil
        // Fails while another player holds the session, which is the wanted outcome.
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// The system level is not the remote's: each key press becomes a step on the remote volume.
    private func systemVolumeChanged(_ level: Float) {
        defer { lastSystemVolume = level }
        guard canSetVolume, level != lastSystemVolume else { return }
        let up = level > lastSystemVolume || level >= 1
        let next = min(max(volume + (up ? Self.volumeStep : -Self.volumeStep), 0), 1)
        volume = next
        emit("volume", next)
    }

    // MARK: - Now playing

    private func publish(playing: Bool) {
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
                self.info[MPMediaItemPropertyArtwork] = artwork
                MPNowPlayingInfoCenter.default().nowPlayingInfo = self.info
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
        add(center.togglePlayPauseCommand) { [weak self] _ in
            let rate = self?.info[MPNowPlayingInfoPropertyPlaybackRate] as? Double ?? 0
            return send(rate > 0 ? "pause" : "play", 0)
        }
        add(center.stopCommand) { _ in send("stop", 0) }
        add(center.nextTrackCommand) { _ in send("next", 0) }
        add(center.previousTrackCommand) { _ in send("seek", 0) }
        add(center.changePlaybackPositionCommand) { event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            return send("seek", event.positionTime)
        }
        for (command, sign) in [(center.skipBackwardCommand, -1.0), (center.skipForwardCommand, 1.0)] {
            add(command) { [weak self] event in
                guard let self, let event = event as? MPSkipIntervalCommandEvent else { return .commandFailed }
                let elapsed = self.info[MPNowPlayingInfoPropertyElapsedPlaybackTime] as? Double ?? 0
                return send("seek", max(elapsed + sign * event.interval, 0))
            }
        }
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
