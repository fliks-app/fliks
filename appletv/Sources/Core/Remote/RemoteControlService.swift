import Foundation
import UIKit

/// Makes this tvOS app a remote-controllable playback target. `APIClient` has
/// no streaming path, so unlike web/desktop (which get commands pushed over
/// SSE) this polls for pending commands every 2s: same cadence as
/// `QuickConnectView`: instead of duplicating reconnect/backoff/token
/// rotation for a second transport.
@Observable final class RemoteControlService {
    static let shared = RemoteControlService()

    private let api = APIClient.shared
    /// Read by `PlaybackService` to stamp the heartbeat so a polled target can
    /// be linked to its live session.
    private(set) var targetId: String?
    private var pollTask: Task<Void, Never>?

    /// Wired by `RootView` to push a fresh player route: the app's existing
    /// "start playing this" entry point: for a `load` command.
    var onLoadRequested: ((_ mediaFileId: Int, _ mediaId: Int, _ episodeId: Int?, _ startAt: Double, _ startPaused: Bool,
                           _ tracks: LaunchTracks) -> Void)?
    /// The on-screen player, if any. Every action but `load` needs one.
    weak var activeCoordinator: PlayerCoordinator?

    /// Set when another device took the account session over: `RootView` shows the alert.
    var supersededPrompt: SupersededPrompt?
    private var supersededGate = SupersededGate()

    struct SupersededPrompt: Identifiable {
        let id = UUID()
        let device: String?
        let mediaFileId: Int
        let mediaId: Int
        let episodeId: Int?
        let position: Double
    }

    private init() {}

    // MARK: - Poll lifecycle

    func startPolling() {
        guard pollTask == nil else { return }
        pollTask = Task { await pollLoop() }
    }

    func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    private func pollLoop() async {
        while !Task.isCancelled {
            if targetId == nil { await register() }
            if let targetId { await fetchAndApply(targetId: targetId) }
            try? await Task.sleep(nanoseconds: 2_000_000_000)
        }
    }

    // MARK: - Registration

    private func register() async {
        struct Body: Encodable { let deviceId: String; let name: String; let formFactor: String }
        do {
            let res: RemoteRegisterResponse = try await api.post(
                "/api/remote/register",
                body: Body(deviceId: DeviceId.current, name: UIDevice.current.name, formFactor: "tv")
            )
            targetId = res.targetId
        } catch {
            // Transient (network, server restart) or the route isn't live yet -
            // the next poll tick retries registration.
            print("remote: registration failed, not controllable yet: \(error)")
        }
    }

    // MARK: - Commands

    private func fetchAndApply(targetId: String) async {
        let path = "/api/remote/commands?targetId=\(targetId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? targetId)"
        do {
            let entries: [RemoteQueueEntry] = try await api.get(path)
            for entry in entries {
                switch entry {
                case .command(let cmd): await apply(cmd)
                case .superseded(let sid, let device): await sessionSuperseded(sessionId: sid, byDeviceName: device)
                case .other: break
                }
            }
        } catch APIError.badStatus(404, _) {
            // The registry has forgotten this target (backend restart) - only a
            // fresh register() can make us controllable again.
            print("remote: target \(targetId) unknown to server (404), re-registering")
            self.targetId = nil
        } catch {
            print("remote: command poll failed, will retry: \(error)")
        }
    }

    /// Another device claimed the account session: remember where we were, leave the player, then
    /// `RootView` offers to take it back. The server skips the superseded session's saves.
    @MainActor
    func sessionSuperseded(sessionId: String, byDeviceName: String?) {
        guard let coordinator = activeCoordinator,
              supersededGate.accept(sessionId, current: coordinator.playback.sessionId) else { return }
        supersededPrompt = SupersededPrompt(
            device: byDeviceName, mediaFileId: coordinator.playback.mediaFileId,
            mediaId: coordinator.currentItemIds.mediaId, episodeId: coordinator.currentItemIds.episodeId,
            position: coordinator.currentPosition)
        coordinator.onStopRequested?()
    }

    /// "Resume here": loads the item again at the saved position, which claims the session back.
    @MainActor
    func resume(_ p: SupersededPrompt) {
        onLoadRequested?(p.mediaFileId, p.mediaId, p.episodeId, p.position, false, LaunchTracks(audioId: nil, subtitleId: nil, subtitleSent: false))
    }

    private static let audioKinds: Set<String> = ["album", "book"]

    /// Audio `load`s start in the music player; a book has no tvOS player and is ignored.
    @MainActor
    private func loadAudio(_ cmd: RemoteCommand, kind: String) {
        guard kind == "album", let mediaId = cmd.mediaId else {
            print("remote: no tvOS player for a \(kind) load (\(cmd.cmdId)), ignoring")
            return
        }
        Task { @MainActor in
            do {
                let page = try await MusicAPI.albumPage(mediaId)
                let all = page.queue(edition: nil)
                let wanted = cmd.queueItemIds ?? cmd.itemId.map { [$0] } ?? all.map(\.itemId)
                let tracks = wanted.compactMap { id in all.first { $0.itemId == id } }
                let current = cmd.queueIndex.flatMap { wanted.indices.contains($0) ? wanted[$0] : nil } ?? cmd.itemId
                let start = tracks.firstIndex { $0.itemId == current } ?? 0
                MusicPlayer.shared.resume(tracks, from: start, shuffle: cmd.shuffle ?? false,
                                          repeatMode: cmd.repeatMode.flatMap(RepeatMode.init(rawValue:)) ?? .off,
                                          position: cmd.positionSeconds ?? 0, autoplay: !(cmd.paused ?? false))
            } catch {
                print("remote: audio load \(cmd.cmdId) failed: \(error)")
            }
        }
    }

    /// `PlayerCoordinator` is `@MainActor`-isolated (it drives `AVPlayer` and
    /// SwiftUI state directly), so applying a command has to hop there too.
    @MainActor
    private func apply(_ cmd: RemoteCommand) {
        guard Date(timeIntervalSince1970: cmd.expiresAt / 1000) > Date() else {
            print("remote: dropping expired command \(cmd.cmdId) (\(cmd.action))")
            return
        }
        if cmd.action == "load" {
            if let kind = cmd.kind, Self.audioKinds.contains(kind) {
                loadAudio(cmd, kind: kind)
                return
            }
            guard let mediaFileId = cmd.mediaFileId, let mediaId = cmd.mediaId else {
                print("remote: load command \(cmd.cmdId) missing mediaFileId/mediaId, ignoring")
                return
            }
            onLoadRequested?(mediaFileId, mediaId, cmd.episodeId, cmd.positionSeconds ?? 0, cmd.paused ?? false,
                             cmd.launchTracks)
            return
        }
        guard let coordinator = activeCoordinator else {
            print("remote: no active player for \(cmd.action) (\(cmd.cmdId)), ignoring")
            return
        }
        coordinator.applyRemoteCommand(cmd)
    }
}
