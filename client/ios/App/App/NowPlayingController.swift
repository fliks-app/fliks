import Foundation
import AVFoundation
import MediaPlayer
import UIKit

/// Lock screen / Control Center presence for the AVPlayer of NativePlayerPlugin.
/// Active only while background playback is on; every entry point runs on the main thread.
final class NowPlayingController {
    private let emitEvent: (String) -> Void
    private let didSeek: () -> Void

    private weak var player: AVPlayer?
    private var active = false
    private var title = ""
    private var artist: String?
    private var artwork: MPMediaItemArtwork?
    /// Bumped on every load so a slow artwork download can't land on the next item.
    private var generation = 0

    private var nav = (hasPrevious: false, hasNext: false, seekButtons: false)
    private var targets: [(command: MPRemoteCommand, token: Any)] = []

    private var interruptionObserver: NSObjectProtocol?
    private var interrupted = false
    private var wasPlaying = false

    init(emitEvent: @escaping (String) -> Void, didSeek: @escaping () -> Void) {
        self.emitEvent = emitEvent
        self.didSeek = didSeek
    }

    // MARK: - Lifecycle

    func activate(
        player: AVPlayer,
        title: String,
        artist: String?,
        artworkUrl: String?,
        headers: [String: String],
        streamHost: String?
    ) {
        self.player = player
        self.title = title
        self.artist = artist
        artwork = nil
        generation += 1
        if !active {
            active = true
            installCommands()
            observeInterruptions()
        }
        applyCommandAvailability()
        publish()
        loadArtwork(urlString: artworkUrl, headers: headers, streamHost: streamHost, generation: generation)
    }

    /// `releaseSession` hands the audio session back so the user's music can resume;
    /// left false when another item is about to play on it.
    func deactivate(releaseSession: Bool) {
        guard active else { return }
        active = false
        generation += 1
        artwork = nil
        interrupted = false
        wasPlaying = false
        player = nil

        for entry in targets { entry.command.removeTarget(entry.token) }
        targets.removeAll()
        let center = MPRemoteCommandCenter.shared()
        for command in managedCommands(center) { command.isEnabled = false }

        if let observer = interruptionObserver {
            NotificationCenter.default.removeObserver(observer)
            interruptionObserver = nil
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        MPNowPlayingInfoCenter.default().playbackState = .stopped

        if releaseSession {
            // Queued so the player pause that precedes a teardown has settled.
            DispatchQueue.main.async { [weak self] in
                if self?.active == true { return }
                try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            }
        }
    }

    /// iOS extrapolates the elapsed time from the rate, so this runs on transitions only.
    func refresh() {
        guard active else { return }
        if !interrupted { wasPlaying = isPlaying }
        publish()
    }

    /// The modern Now Playing UI has no like button, so `liked` is not part of this.
    func setQueueNav(hasPrevious: Bool, hasNext: Bool, seekButtons: Bool) {
        nav = (hasPrevious, hasNext, seekButtons)
        if active { applyCommandAvailability() }
    }

    // MARK: - Now playing info

    private var isPlaying: Bool {
        guard let player = player, player.currentItem != nil else { return false }
        return player.timeControlStatus != .paused
    }

    private func publish() {
        guard let player = player else { return }
        // A stall keeps `rate` at the requested value; iOS would extrapolate through it.
        let advancing = player.currentItem != nil && player.timeControlStatus == .playing
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: title,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.video.rawValue,
            MPNowPlayingInfoPropertyPlaybackRate: advancing ? Double(player.rate) : 0.0,
        ]
        if let artist = artist { info[MPMediaItemPropertyArtist] = artist }
        if let artwork = artwork { info[MPMediaItemPropertyArtwork] = artwork }
        if let item = player.currentItem {
            let duration = item.duration.seconds
            if duration.isFinite, duration > 0 { info[MPMediaItemPropertyPlaybackDuration] = duration }
            let elapsed = player.currentTime().seconds
            info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = elapsed.isFinite ? max(elapsed, 0) : 0
        }
        let center = MPNowPlayingInfoCenter.default()
        center.nowPlayingInfo = info
        center.playbackState = isPlaying ? .playing : .paused
    }

    private func loadArtwork(urlString: String?, headers: [String: String], streamHost: String?, generation: Int) {
        guard let urlString = urlString, let url = URL(string: urlString) else { return }
        var request = URLRequest(url: url)
        // The bearer token is for the Fliks server only.
        if url.host == streamHost {
            for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
        }
        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            guard let data = data, let image = UIImage(data: data) else { return }
            let artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
            DispatchQueue.main.async {
                guard let self = self, self.active, self.generation == generation else { return }
                self.artwork = artwork
                self.publish()
            }
        }.resume()
    }

    // MARK: - Remote commands

    private func managedCommands(_ center: MPRemoteCommandCenter) -> [MPRemoteCommand] {
        [
            center.playCommand, center.pauseCommand, center.togglePlayPauseCommand,
            center.changePlaybackPositionCommand, center.skipBackwardCommand, center.skipForwardCommand,
            center.nextTrackCommand, center.previousTrackCommand,
        ]
    }

    private func add(_ command: MPRemoteCommand, _ handler: @escaping (MPRemoteCommandEvent) -> MPRemoteCommandHandlerStatus) {
        targets.append((command, command.addTarget(handler: handler)))
    }

    private func installCommands() {
        let center = MPRemoteCommandCenter.shared()

        add(center.playCommand) { [weak self] _ in
            guard let player = self?.player, player.currentItem != nil else { return .noActionableNowPlayingItem }
            player.play()
            return .success
        }
        add(center.pauseCommand) { [weak self] _ in
            guard let player = self?.player, player.currentItem != nil else { return .noActionableNowPlayingItem }
            player.pause()
            return .success
        }
        add(center.togglePlayPauseCommand) { [weak self] _ in
            guard let self = self, let player = self.player, player.currentItem != nil else {
                return .noActionableNowPlayingItem
            }
            if self.isPlaying { player.pause() } else { player.play() }
            return .success
        }
        add(center.changePlaybackPositionCommand) { [weak self] event in
            guard let self = self, let event = event as? MPChangePlaybackPositionCommandEvent else {
                return .commandFailed
            }
            self.seek(to: event.positionTime)
            return .success
        }
        add(center.skipBackwardCommand) { [weak self] event in
            guard let self = self, let event = event as? MPSkipIntervalCommandEvent else { return .commandFailed }
            self.seek(by: -event.interval)
            return .success
        }
        add(center.skipForwardCommand) { [weak self] event in
            guard let self = self, let event = event as? MPSkipIntervalCommandEvent else { return .commandFailed }
            self.seek(by: event.interval)
            return .success
        }
        add(center.nextTrackCommand) { [weak self] _ in
            self?.emitEvent("nativePlayerNext")
            return .success
        }
        add(center.previousTrackCommand) { [weak self] _ in
            guard let self = self else { return .commandFailed }
            if self.nav.hasPrevious {
                self.emitEvent("nativePlayerPrevious")
            } else {
                self.seek(to: 0)
            }
            return .success
        }
    }

    /// Previous is always offered (it restarts the item without a predecessor), next only
    /// with a successor; a film has the +/-10 s buttons instead.
    private func applyCommandAvailability() {
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.isEnabled = true
        center.pauseCommand.isEnabled = true
        center.togglePlayPauseCommand.isEnabled = true
        center.changePlaybackPositionCommand.isEnabled = true
        center.skipBackwardCommand.preferredIntervals = [10]
        center.skipForwardCommand.preferredIntervals = [10]
        center.skipBackwardCommand.isEnabled = nav.seekButtons
        center.skipForwardCommand.isEnabled = nav.seekButtons
        center.nextTrackCommand.isEnabled = !nav.seekButtons && nav.hasNext
        center.previousTrackCommand.isEnabled = !nav.seekButtons
    }

    private func seek(by delta: Double) {
        guard let player = player else { return }
        seek(to: player.currentTime().seconds + delta)
    }

    private func seek(to seconds: Double) {
        guard let player = player, player.currentItem != nil, seconds.isFinite else { return }
        var target = max(seconds, 0)
        let duration = player.currentItem?.duration.seconds ?? 0
        if duration.isFinite, duration > 0 { target = min(target, duration) }
        player.seek(
            to: CMTime(seconds: target, preferredTimescale: 1000),
            toleranceBefore: .zero,
            toleranceAfter: .zero
        ) { [weak self] _ in
            DispatchQueue.main.async {
                self?.publish()
                self?.didSeek()
            }
        }
        publish()
    }

    // MARK: - Interruptions

    private func observeInterruptions() {
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            self?.handleInterruption(note)
        }
    }

    private func handleInterruption(_ note: Notification) {
        guard active,
              let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        switch type {
        case .began:
            wasPlaying = isPlaying || wasPlaying
            interrupted = true
        case .ended:
            interrupted = false
            let raw = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            let shouldResume = AVAudioSession.InterruptionOptions(rawValue: raw).contains(.shouldResume)
            if shouldResume, wasPlaying { player?.play() }
            wasPlaying = isPlaying
        @unknown default:
            break
        }
    }
}
