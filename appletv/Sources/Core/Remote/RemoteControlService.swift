import Foundation
import os
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
    /// Echoed by every beat as `lastCmdId`, the ack a controller waits on; a `load` is acked by the player it starts.
    @ObservationIgnored var lastAppliedCmdId: String?

    /// An audio `load` was applied: the Now Playing screen opens.
    var onOpenMusic: (() -> Void)?
    /// Wired by `RootView` to push a fresh player route: the app's existing
    /// "start playing this" entry point: for a `load` command.
    var onLoadRequested: ((_ mediaFileId: Int, _ mediaId: Int, _ episodeId: Int?, _ startAt: Double?, _ startPaused: Bool,
                           _ tracks: LaunchTracks) -> Void)?
    /// The on-screen player, if any. Every action but `load` needs one.
    weak var activeCoordinator: PlayerCoordinator?

    private var supersededGate = SupersededGate()

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
                body: Body(deviceId: DeviceId.current, name: DeviceName.current, formFactor: "tv")
            )
            targetId = res.targetId
        } catch {
            // Transient (network, server restart) or the route isn't live yet -
            // the next poll tick retries registration.
            Log.remote.error("registration failed, not controllable yet: \(String(describing: error), privacy: .public)")
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
                case .superseded(let sid, _):
                    await sessionSuperseded(sessionId: sid)
                case .other: break
                }
            }
        } catch APIError.badStatus(404, _) {
            // The registry has forgotten this target (backend restart) - only a
            // fresh register() can make us controllable again.
            Log.remote.notice("target \(targetId, privacy: .public) unknown to server (404), re-registering")
            self.targetId = nil
        } catch {
            Log.remote.error("command poll failed, will retry: \(String(describing: error), privacy: .public)")
        }
    }

    /// Another device claimed the account session: the player closes, silently. The server skips the superseded session's saves.
    @MainActor
    func sessionSuperseded(sessionId: String) {
        if MusicPlayer.shared.holds(sessionId: sessionId) { return MusicPlayer.shared.stop() }
        guard let coordinator = activeCoordinator,
              supersededGate.accept(sessionId, current: coordinator.playback.sessionId) else { return }
        coordinator.onStopRequested?()
    }

    private static let audioKinds: Set<String> = ["album", "book"]

    /// Audio `load`s start in the music player; a book has no tvOS player and is ignored.
    @MainActor
    private func loadAudio(_ cmd: RemoteCommand, kind: String) {
        guard kind == "album", let mediaId = cmd.mediaId else {
            Log.remote.notice("no tvOS player for a \(kind, privacy: .public) load (\(cmd.cmdId, privacy: .public)), ignoring")
            return
        }
        Task { @MainActor in
            do {
                let all = try await MusicAPI.albumPage(mediaId).queue
                let wanted = cmd.queueItemIds ?? cmd.itemId.map { [$0] } ?? all.map(\.itemId)
                let (tracks, start) = try await Self.queueTracks(wanted, at: cmd.queueIndex ?? 0, known: all)
                lastAppliedCmdId = cmd.cmdId
                onOpenMusic?()
                MusicPlayer.shared.resume(tracks, from: start, shuffle: cmd.shuffle ?? false,
                                          repeatMode: cmd.repeatMode.flatMap(RepeatMode.init(rawValue:)) ?? .off,
                                          position: cmd.positionSeconds ?? 0, autoplay: !(cmd.paused ?? false))
            } catch {
                Log.remote.error("audio load \(cmd.cmdId, privacy: .public) failed: \(String(describing: error), privacy: .public)")
            }
        }
    }

    /// The tracks of `ids` in order, `at` mapped onto them: `known` ones as they are (their album gain
    /// included), the others fetched by id, an unreadable one left out.
    private static func queueTracks(_ ids: [Int], at index: Int, known: [QueueTrack]) async throws -> ([QueueTrack], Int) {
        let missing = Array(Set(ids).subtracting(known.map(\.itemId)))
        let fetched = try await MusicAPI.tracks(ids: missing).map(QueueTrack.init(row:))
        var pool: [Int: QueueTrack] = [:]
        for t in known + fetched where pool[t.itemId] == nil { pool[t.itemId] = t }
        var tracks: [QueueTrack] = []
        var start = 0
        for (i, id) in ids.enumerated() {
            if i == index { start = tracks.count }
            if let t = pool[id] { tracks.append(t) }
        }
        return (tracks, min(start, max(tracks.count - 1, 0)))
    }

    /// `PlayerCoordinator` is `@MainActor`-isolated (it drives `AVPlayer` and
    /// SwiftUI state directly), so applying a command has to hop there too.
    @MainActor
    private func apply(_ cmd: RemoteCommand) {
        guard Date(timeIntervalSince1970: cmd.expiresAt / 1000) > Date() else {
            Log.remote.notice("dropping expired command \(cmd.cmdId, privacy: .public) (\(cmd.action, privacy: .public))")
            return
        }
        if cmd.action == "load" {
            if let kind = cmd.kind, Self.audioKinds.contains(kind) {
                loadAudio(cmd, kind: kind)
                return
            }
            guard let mediaFileId = cmd.mediaFileId, let mediaId = cmd.mediaId else {
                Log.remote.notice("load command \(cmd.cmdId, privacy: .public) missing mediaFileId/mediaId, ignoring")
                return
            }
            lastAppliedCmdId = cmd.cmdId
            onLoadRequested?(mediaFileId, mediaId, cmd.episodeId, cmd.positionSeconds, cmd.paused ?? false,
                             cmd.launchTracks)
            return
        }
        guard let coordinator = activeCoordinator else {
            if MusicPlayer.shared.current != nil { return applyMusic(cmd) }
            Log.remote.notice("no active player for \(cmd.action, privacy: .public) (\(cmd.cmdId, privacy: .public)), ignoring")
            return
        }
        coordinator.applyRemoteCommand(cmd)
    }

    /// The commands the music player supports; the others (volume, tracks, quality) are the video player's.
    @MainActor
    private func applyMusic(_ cmd: RemoteCommand) {
        let player = MusicPlayer.shared
        lastAppliedCmdId = cmd.cmdId
        switch cmd.action {
        case "play": player.perform(.play)
        case "pause": player.perform(.pause)
        case "playpause": player.togglePlayPause()
        case "stop": player.stop()
        case "seek": if let p = cmd.positionSeconds { player.perform(.seek(p)) }
        case "next": player.perform(.next)
        case "prev": player.previousTrack()
        case "queue":
            guard let ids = cmd.queueItemIds, let index = cmd.queueIndex else { return player.acknowledge() }
            if ids == player.queue.tracks.map(\.itemId) { return player.skip(to: index) }
            Task { @MainActor in
                if let q = try? await Self.queueTracks(ids, at: index, known: player.queue.tracks) {
                    player.replaceQueue(q.0, from: q.1, shuffle: cmd.shuffle ?? player.shuffled)
                } else {
                    player.acknowledge()
                }
            }
        case "enqueue":
            guard let ids = cmd.itemIds, let at = cmd.enqueueAt else { return player.acknowledge() }
            Task { @MainActor in
                let tracks = (try? await Self.queueTracks(ids, at: 0, known: []).0) ?? []
                if at == "next" { player.addNext(tracks) } else { player.addLast(tracks) }
                player.acknowledge()
            }
        case "shuffle": player.setShuffle(cmd.shuffle ?? !player.shuffled); player.acknowledge()
        case "repeat":
            player.setRepeat(cmd.repeatMode.flatMap(RepeatMode.init(rawValue:)) ?? player.repeatMode.next)
            player.acknowledge()
        default:
            Log.remote.notice("the music player ignores \(cmd.action, privacy: .public) (\(cmd.cmdId, privacy: .public))")
            player.acknowledge()
        }
    }
}
