import Capacitor
import AVFoundation
import AVKit
import CoreMedia
import UIKit

extension NativePlayerPlugin {
    // MARK: - Private Helpers

    func setupObservers() {
        guard let player = player else { return }

        // Periodic time observer (every second)
        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 1, preferredTimescale: 1000),
            queue: .main
        ) { [weak self] _ in
            self?.emitTimeUpdate()
        }

        installMuteBoundaries()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleTimeJumped(_:)),
            name: AVPlayerItem.timeJumpedNotification,
            object: player.currentItem
        )

        // Anamorphic sources report their display size only once loaded.
        presentationSizeObserver = player.currentItem?.observe(
            \.presentationSize, options: [.new]
        ) { [weak self] _, _ in
            DispatchQueue.main.async { self?.layoutVideoLayer() }
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
                DispatchQueue.main.async { self?.nowPlaying.refresh() }
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
            // Over AirPlay the receiver shows the video: the phone may sleep.
            let awake = player.timeControlStatus != .paused && !player.isExternalPlaybackActive
            DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = awake }
            DispatchQueue.main.async { self?.nowPlaying.refresh() }
            switch player.timeControlStatus {
            case .paused:
                self?.emitStateChanged("paused")
            case .waitingToPlayAtSpecifiedRate:
                // The periodic push stops with the picture: a stall must read the buffer it starts on.
                self?.emitTimeUpdate()
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

        externalPlaybackObserver = player.observe(\.isExternalPlaybackActive, options: [.initial, .new]) { [weak self] player, _ in
            let active = player.isExternalPlaybackActive
            DispatchQueue.main.async {
                guard let self = self else { return }
                UIApplication.shared.isIdleTimerDisabled = player.timeControlStatus != .paused && !active
                self.setExternalPlayback(active)
            }
        }

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleRateChange(_:)),
            name: AVPlayer.rateDidChangeNotification,
            object: player
        )

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

    @objc private func handleTimeJumped(_ notification: Notification) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let p = self.player else { return }
            self.applyMuteGate(at: p.currentTime().seconds)
            self.emitTimeUpdate()
        }
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

    /// A receiver that cannot play the stream stops the player without an item
    /// error: the only trace is a drop to rate 0 nobody asked for (a pause from
    /// the app reports `.setRateCalled`, an interruption its own reason).
    @objc private func handleRateChange(_ notification: Notification) {
        let reason = notification.userInfo?[AVPlayer.rateDidChangeReasonKey] as? AVPlayer.RateDidChangeReason
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard self.externalPlaybackActive,
                  let player = self.player, player.rate == 0,
                  reason == nil || reason == .setRateFailed,
                  !self.atEnd(player) else { return }
            self.emitExternalPlaybackFailed(reason: "rate dropped to 0 (\(reason?.rawValue ?? "no reason"))")
        }
    }

    func emitExternalPlaybackFailed(reason: String) {
        let data = try? JSONSerialization.data(withJSONObject: ["reason": reason])
        let detail = data.flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        bridge?.webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('nativePlayerExternalPlaybackFailed', { detail: \(detail) }));")
    }

    func atEnd(_ player: AVPlayer) -> Bool {
        guard let duration = player.currentItem?.duration.seconds, duration.isFinite else { return false }
        return player.currentTime().seconds >= duration - 1
    }

    @objc private func playerDidFinishPlaying() {
        emitStateChanged("ended")
    }

    func removeObservers() {
        removeMuteBoundaries()
        if let obs = timeObserver {
            player?.removeTimeObserver(obs)
            timeObserver = nil
        }
        statusObserver?.invalidate()
        statusObserver = nil
        presentationSizeObserver?.invalidate()
        presentationSizeObserver = nil
        firstFrameObserver?.invalidate()
        firstFrameObserver = nil
        timeControlObserver?.invalidate()
        timeControlObserver = nil
        externalPlaybackObserver?.invalidate()
        externalPlaybackObserver = nil
        NotificationCenter.default.removeObserver(self)
    }

    func cleanup() {
        removeObservers()
        setExternalPlayback(false)
        player?.pause()
        player = nil
        externalPlaybackBeforeMute = nil
        muteRanges = []
        nowPlaying.deactivate(releaseSession: true)
        playerLayer?.removeFromSuperlayer()
        playerLayer = nil
        playerView?.removeFromSuperview()
        playerView = nil
        videoCrop = nil
        fillScreen = false
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

    func getBufferedPosition() -> Double {
        guard let ranges = player?.currentItem?.loadedTimeRanges else { return 0 }
        if let range = ranges.last?.timeRangeValue {
            let end = CMTimeGetSeconds(range.start) + CMTimeGetSeconds(range.duration)
            return end.isFinite ? end : 0
        }
        return 0
    }

    // MARK: - Event Emitters

    func emitStateChanged(_ state: String) {
        let js = "window.dispatchEvent(new CustomEvent('nativePlayerStateChanged', { detail: { state: '\(state)' } }));"
        DispatchQueue.main.async { [weak self] in
            self?.bridge?.webView?.evaluateJavaScript(js)
        }
    }

    func emitWindowEvent(_ name: String) {
        let js = "window.dispatchEvent(new CustomEvent('\(name)'));"
        DispatchQueue.main.async { [weak self] in
            self?.bridge?.webView?.evaluateJavaScript(js)
        }
    }

    func emitFirstFrame() {
        let js = "window.dispatchEvent(new CustomEvent('nativePlayerFirstFrame'));"
        DispatchQueue.main.async { [weak self] in
            self?.bridge?.webView?.evaluateJavaScript(js)
        }
    }

    func emitTimeUpdate() {
        let pos = player?.currentTime().seconds ?? 0
        let dur = player?.currentItem?.duration.seconds ?? 0
        let buf = getBufferedPosition()

        let js = "window.dispatchEvent(new CustomEvent('nativePlayerTimeUpdate', { detail: { position: \(pos.isFinite ? pos : 0), duration: \(dur.isFinite ? dur : 0), buffered: \(buf) } }));"
        DispatchQueue.main.async { [weak self] in
            self?.bridge?.webView?.evaluateJavaScript(js)
        }
    }

    func emitError(code: Int, message: String) {
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

    func ensureMediaSelectionPopulated(retries: Int = 8) {
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

    func emitTracksChanged() {
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

        let subtitleTracks = legibleGroup.map(Self.subtitleTracks) ?? []

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
