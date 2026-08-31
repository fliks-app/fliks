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
    var onLoadRequested: ((_ mediaFileId: Int, _ mediaId: Int, _ episodeId: Int?, _ startAt: Double) -> Void)?
    /// The on-screen player, if any. Every action but `load` needs one.
    weak var activeCoordinator: PlayerCoordinator?

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
            let commands: [RemoteCommand] = try await api.get(path)
            for cmd in commands { await apply(cmd) }
        } catch APIError.badStatus(404) {
            // The registry has forgotten this target (backend restart) - only a
            // fresh register() can make us controllable again.
            print("remote: target \(targetId) unknown to server (404), re-registering")
            self.targetId = nil
        } catch {
            print("remote: command poll failed, will retry: \(error)")
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
            guard let mediaFileId = cmd.mediaFileId, let mediaId = cmd.mediaId else {
                print("remote: load command \(cmd.cmdId) missing mediaFileId/mediaId, ignoring")
                return
            }
            onLoadRequested?(mediaFileId, mediaId, cmd.episodeId, cmd.positionSeconds ?? 0)
            return
        }
        guard let coordinator = activeCoordinator else {
            print("remote: no active player for \(cmd.action) (\(cmd.cmdId)), ignoring")
            return
        }
        coordinator.applyRemoteCommand(cmd)
    }
}
