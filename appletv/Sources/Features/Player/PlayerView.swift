import SwiftUI
import UIKit
import Foundation
import AVFoundation
import AVKit

/// Fullscreen native tvOS player. `AVPlayerViewController` wrapped via
/// `UIViewControllerRepresentable` — system scrub bar, info panel, and
/// audio/subtitle pickers come free. Skip-intro / next-episode surface as
/// `contextualActions` (tvOS 15+ API built for exactly this).
struct PlayerView: View {
    let mediaFileId: Int
    let mediaId: Int
    let episodeId: Int?
    let startAt: Double
    /// Called when the user dismisses a terminal error card.
    var onExit: () -> Void

    @State private var coordinator = PlayerCoordinator()
    @State private var loading = true
    @State private var loadErrorText: String?

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if let player = coordinator.player {
                PlayerContainer(player: player, coordinator: coordinator)
                    .ignoresSafeArea()
            }

            if coordinator.recoveringHint {
                Text(tr("player.reconnecting"))
                    .font(.callout)
                    .padding(12)
                    .background(.black.opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
                    .padding(.top, 60)
                    .frame(maxHeight: .infinity, alignment: .top)
            }

            if coordinator.showSkipIntro {
                SkipIntroButton(progress: coordinator.skipIntroProgress,
                                secondsLeft: coordinator.skipIntroSecondsLeft) { coordinator.skipIntro() }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                    .padding(60)
            }

            if let text = loadErrorText ?? (coordinator.fatalError ? tr("player.playback_error") : nil) {
                VStack(spacing: 20) {
                    Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 64))
                    Text(text).font(.title2)
                    Button(tr("common.ok"), action: onExit)
                }
                .foregroundStyle(.white)
            } else if loading {
                ProgressView().controlSize(.large).tint(.white)
            }
        }
        .task {
            do {
                try await coordinator.load(mediaFileId: mediaFileId, mediaId: mediaId, episodeId: episodeId, startAt: startAt)
            } catch {
                loadErrorText = tr("player.load_error")
            }
            loading = false
        }
        .onDisappear { coordinator.teardown() }
    }
}

/// Bridges the coordinator's `AVPlayer` into a native `AVPlayerViewController`.
private struct PlayerContainer: UIViewControllerRepresentable {
    let player: AVPlayer
    let coordinator: PlayerCoordinator

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let vc = AVPlayerViewController()
        vc.player = player
        vc.requiresLinearPlayback = false
        coordinator.playerViewController = vc
        return vc
    }

    func updateUIViewController(_ uiViewController: AVPlayerViewController, context: Context) {
        if uiViewController.player !== player {
            uiViewController.player = player
        }
    }
}

/// Compact skip-intro badge: icon + label + countdown, with an in-badge fill
/// that empties over the reveal window (time left before it retracts). Custom
/// focus ring (no system chrome); takes focus on appear.
private struct SkipIntroButton: View {
    let progress: Double      // 0..1 elapsed
    let secondsLeft: Int
    var action: () -> Void
    @FocusState private var focused: Bool

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: "forward.end.fill")
                Text("\(tr("player.skip_intro")) (\(secondsLeft))")
            }
            .font(.callout.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 22)
            .padding(.vertical, 12)
            .background(alignment: .leading) {
                GeometryReader { geo in
                    Rectangle()
                        .fill(.white.opacity(0.28))
                        .frame(width: geo.size.width * (1 - min(1, max(0, progress))))
                        .animation(.linear(duration: 1), value: progress)
                }
            }
            .background(.white.opacity(0.14))
            .clipShape(Capsule())
            .overlay(Capsule().strokeBorder(.white, lineWidth: focused ? 4 : 0))
        }
        .buttonStyle(SkipCueStyle())
        .scaleEffect(focused ? 1.06 : 1)
        .focused($focused)
        .onAppear { focused = true }
        .animation(.easeOut(duration: 0.15), value: focused)
    }
}

private struct SkipCueStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.85 : 1)
    }
}

/// Owns the `AVPlayer`, the `PlaybackService` session, and everything that
/// needs the live playhead: heartbeat/watchdog ticks, skip-intro auto-skip,
/// next-episode resolution + autoplay, and the preferred-subtitle pick.
@MainActor
@Observable final class PlayerCoordinator {
    let playback = PlaybackService()
    var player: AVPlayer?
    var recoveringHint = false
    var fatalError = false
    weak var playerViewController: AVPlayerViewController?

    private var mediaFileId = 0
    private var mediaId = 0
    private var episodeId: Int?
    private var media: Media?
    private var nextEpisode: (mediaFileId: Int, episodeId: Int)?

    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var statusObservation: NSKeyValueObservation?
    private var rateObservation: NSKeyValueObservation?

    private var autoSkippedIntro = false
    private var autoAdvancedNext = false
    private var skipIntroArmed = false
    private var skipIntroDismissed = false
    private var skipIntroShownAt: Double = 0
    private var skipIntroTarget: Double = 0
    private var contextualKey = ""
    private var lastTickTime: Double = -1
    private let skipIntroRevealSeconds: Double = 10

    /// Custom skip-intro cue (a focusable badge with an in-badge progress fill)
    /// — the native `contextualActions` can't show progress and the system
    /// retracts them with the transport bar after a few seconds.
    var showSkipIntro = false
    var skipIntroProgress: Double = 0
    var skipIntroSecondsLeft = 0

    init() {
        playback.onReload = { [weak self] url, position in
            Task { @MainActor in self?.reload(url: url, position: position) }
        }
        playback.onFatalError = { [weak self] in
            Task { @MainActor in self?.fatalError = true }
        }
    }

    // MARK: - Load / reload / teardown

    func load(mediaFileId: Int, mediaId: Int, episodeId: Int?, startAt: Double) async throws {
        self.mediaFileId = mediaFileId
        self.mediaId = mediaId
        self.episodeId = episodeId
        let fetchedMedia: Media? = try? await APIClient.shared.get("/api/media/\(mediaId)")
        media = fetchedMedia
        resolveNextEpisode()

        let sourceAudio = media?.files?.first { $0.id == mediaFileId }?.streamInfo?.audio
        let url = try await playback.start(
            mediaFileId: mediaFileId, mediaId: mediaId, episodeId: episodeId,
            startAt: startAt, audioStreams: sourceAudio
        )
        let item = AVPlayerItem(url: url)
        let p = AVPlayer(playerItem: item)
        player = p
        attachObservers(to: p, item: item, initialSeek: startAt)
        applyPreferredSubtitle(to: item, player: p)
        p.play()
    }

    private func reload(url: URL, position: Double) {
        guard let player else { return }
        let wasPaused = player.timeControlStatus == .paused
        let item = AVPlayerItem(url: url)
        player.replaceCurrentItem(with: item)
        player.seek(to: CMTime(seconds: position, preferredTimescale: 600))
        attachItemObservers(item)
        applyPreferredSubtitle(to: item, player: player)
        if !wasPaused { player.play() }
    }

    func teardown() {
        playback.stop()
        if let timeObserver, let player { player.removeTimeObserver(timeObserver) }
        timeObserver = nil
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = nil
        statusObservation = nil
        rateObservation = nil
        player?.pause()
        player = nil
    }

    // MARK: - Next-episode resolution

    /// Walks `media.seasons`/`episodes` for the episode after `episodeId` —
    /// next in the same season, else the first episode of the next season.
    /// Only resolved when it has a downloaded file.
    private func resolveNextEpisode() {
        nextEpisode = nil
        guard let media, media.type == "series", let episodeId, let seasons = media.seasons else { return }
        let sorted = seasons.sorted { $0.seasonNumber < $1.seasonNumber }
        for (si, season) in sorted.enumerated() {
            let eps = season.episodes.sorted { $0.episodeNumber < $1.episodeNumber }
            guard let idx = eps.firstIndex(where: { $0.id == episodeId }) else { continue }
            let candidate: Episode?
            if idx + 1 < eps.count {
                candidate = eps[idx + 1]
            } else if si + 1 < sorted.count {
                candidate = sorted[si + 1].episodes.sorted { $0.episodeNumber < $1.episodeNumber }.first
            } else {
                candidate = nil
            }
            if let candidate, candidate.hasFile, let file = media.files?.first(where: { $0.episodeId == candidate.id }) {
                nextEpisode = (file.id, candidate.id)
            }
            return
        }
    }

    private func advance(to next: (mediaFileId: Int, episodeId: Int)) async {
        let duration = player?.currentItem?.duration.seconds ?? 0
        if duration.isFinite, duration > 0 { playback.markComplete(duration: duration) }
        playback.stop()
        mediaFileId = next.mediaFileId
        episodeId = next.episodeId
        autoSkippedIntro = false
        autoAdvancedNext = false
        skipIntroArmed = false
        skipIntroDismissed = false
        showSkipIntro = false
        contextualKey = ""
        lastTickTime = -1
        resolveNextEpisode()
        let sourceAudio = media?.files?.first { $0.id == next.mediaFileId }?.streamInfo?.audio
        guard let url = try? await playback.start(
            mediaFileId: next.mediaFileId, mediaId: mediaId, episodeId: next.episodeId,
            startAt: 0, audioStreams: sourceAudio
        ) else { return }
        reload(url: url, position: 0)
    }

    // MARK: - Observers

    private func attachObservers(to player: AVPlayer, item: AVPlayerItem, initialSeek: Double) {
        if initialSeek > 0 {
            player.seek(to: CMTime(seconds: initialSeek, preferredTimescale: 600))
        }
        let interval = CMTime(seconds: 1, preferredTimescale: 1)
        timeObserver = player.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self] time in
            Task { @MainActor in self?.onTick(time: time.seconds) }
        }
        rateObservation = player.observe(\.timeControlStatus, options: [.new]) { [weak self] player, _ in
            let paused = player.timeControlStatus != .playing
            let position = player.currentTime().seconds
            let duration = player.currentItem?.duration.seconds ?? 0
            Task { @MainActor in
                self?.playback.notifyStateChange(
                    position: position.isFinite ? position : 0,
                    duration: duration.isFinite ? duration : 0,
                    paused: paused
                )
            }
        }
        attachItemObservers(item)
    }

    private func attachItemObservers(_ item: AVPlayerItem) {
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.onEnded() }
        }
        statusObservation = item.observe(\.status, options: [.new]) { [weak self] item, _ in
            guard item.status == .failed else { return }
            Task { @MainActor in
                let position = self?.player?.currentTime().seconds ?? 0
                self?.playback.handleItemFailed(position: position.isFinite ? position : 0)
            }
        }
    }

    private func onTick(time: Double) {
        guard time.isFinite else { return }
        let durationRaw = player?.currentItem?.duration.seconds ?? 0
        let duration = durationRaw.isFinite ? durationRaw : 0
        let paused = player?.timeControlStatus != .playing
        playback.tick(position: time, duration: duration, paused: paused)
        recoveringHint = playback.recovering

        // A jump larger than normal playback advance is a seek — re-arm cues.
        let seeked = lastTickTime >= 0 && abs(time - lastTickTime) > 1.5
        lastTickTime = time

        let settings = AppSettingsStore.shared
        if let intro = playback.info?.markers?.intro, settings.autoSkipIntro, !autoSkippedIntro,
           time >= intro.startSeconds, time < intro.endSeconds {
            autoSkippedIntro = true
            player?.seek(to: CMTime(seconds: intro.endSeconds, preferredTimescale: 600))
        }
        updateSkipIntro(time: time, seeked: seeked)
        updateContextualActions(time: time, duration: duration)
    }

    /// Reveal the skip-intro cue on entering the intro window (or on any seek
    /// while inside it) and fill its progress over `skipIntroRevealSeconds`,
    /// then retract. A seek re-anchors the window so the timer restarts.
    private func updateSkipIntro(time: Double, seeked: Bool) {
        guard let intro = playback.info?.markers?.intro, !AppSettingsStore.shared.autoSkipIntro,
              time >= intro.startSeconds, time < intro.endSeconds else {
            skipIntroArmed = false
            showSkipIntro = false
            skipIntroDismissed = false
            return
        }
        // After an explicit skip, stay hidden until we leave the window — the
        // skip-seek would otherwise be read as a seek and re-arm the counter.
        if skipIntroDismissed { showSkipIntro = false; return }
        if !skipIntroArmed || seeked {
            skipIntroArmed = true
            skipIntroShownAt = time
            skipIntroTarget = intro.endSeconds
        }
        let elapsed = time - skipIntroShownAt
        showSkipIntro = elapsed < skipIntroRevealSeconds
        skipIntroProgress = min(1, max(0, elapsed / skipIntroRevealSeconds))
        skipIntroSecondsLeft = max(0, Int(ceil(skipIntroRevealSeconds - elapsed)))
    }

    func skipIntro() {
        skipIntroDismissed = true
        player?.seek(to: CMTime(seconds: skipIntroTarget, preferredTimescale: 600))
        showSkipIntro = false
        skipIntroArmed = false
    }

    private func onEnded() {
        guard AppSettingsStore.shared.autoPlayNext, !autoAdvancedNext, let next = nextEpisode else { return }
        autoAdvancedNext = true
        Task { await advance(to: next) }
    }

    /// Next-episode as a native contextual action. Reassigned only when the
    /// visible set changes — reassigning every tick makes tvOS re-present the
    /// button and pulse.
    private func updateContextualActions(time: Double, duration: Double) {
        let showNext = nextEpisode != nil && duration > 0 && duration - time < 30
        let key = showNext ? "n" : ""
        guard key != contextualKey else { return }
        contextualKey = key
        if showNext, let next = nextEpisode {
            playerViewController?.contextualActions = [
                UIAction(title: tr("player.next_episode")) { [weak self] _ in
                    Task { @MainActor in await self?.advance(to: next) }
                }
            ]
        } else {
            playerViewController?.contextualActions = []
        }
    }

    // MARK: - Subtitle preference

    /// Native HLS `SUBTITLES` renditions surface as an `AVMediaSelectionGroup`
    /// — pick from it, no extra network call:
    ///   - off: nothing selected, and AVFoundation's own heuristic disabled;
    ///   - always: the preferred language, else the first track;
    ///   - intelligent: the preferred language only when the audio is in
    ///     another one (same rule as the web `track-manager`).
    private func applyPreferredSubtitle(to item: AVPlayerItem, player: AVPlayer) {
        let settings = AppSettingsStore.shared
        let mode = settings.subtitleMode
        let preferred = settings.preferredSubtitleLanguage
        player.appliesMediaSelectionCriteriaAutomatically = mode != "off"

        Task {
            guard let group = try? await item.asset.loadMediaSelectionGroup(for: .legible) else { return }
            if mode == "off" {
                item.select(nil, in: group)
                return
            }

            let match = preferred.isEmpty ? nil : AVMediaSelectionGroup.mediaSelectionOptions(
                from: group.options, with: Locale(identifier: preferred)
            ).first

            if mode == "always" {
                item.select(match ?? group.options.first, in: group)
                return
            }
            guard let match, let audio = await audioLanguage(of: item),
                  audio != Self.languageCode(preferred) else { return }
            item.select(match, in: group)
        }
    }

    /// Language of the audio actually playing — the selected option when the
    /// stream carries several, else the only track's own tag.
    private func audioLanguage(of item: AVPlayerItem) async -> String? {
        if let group = try? await item.asset.loadMediaSelectionGroup(for: .audible),
           let selected = item.currentMediaSelection.selectedMediaOption(in: group),
           let tag = selected.extendedLanguageTag {
            return Self.languageCode(tag)
        }
        let track = try? await item.asset.loadTracks(withMediaType: .audio).first
        guard let tag = try? await track?.load(.languageCode) else { return nil }
        return Self.languageCode(tag)
    }

    /// `fra` and `fr` are the same language; `und` is no language at all.
    private static func languageCode(_ tag: String?) -> String? {
        guard let tag, !tag.isEmpty, tag != "und" else { return nil }
        return Locale.LanguageCode(tag).identifier(.alpha2) ?? tag
    }
}
