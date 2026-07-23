import Foundation

/// One playback session: playback-info -> play URL, ~10s heartbeat (+ instant
/// heartbeat on every play/pause transition), teardown, and lost-session /
/// stall-watchdog recovery. Mirrors client/src/app/features/player/player.ts.
/// Doesn't hold an AVPlayer — PlayerView's coordinator feeds live playhead
/// state via `tick`/`notifyStateChange` and reacts to `onReload`.
@Observable final class PlaybackService {
    private let api = APIClient.shared

    private(set) var info: PlaybackInfoResponse?
    /// True while a lost-session / stall reload is in flight.
    private(set) var recovering = false

    private var mediaFileId = 0
    private var mediaId = 0
    private var episodeId: Int?
    private var sessionId: String?
    private var destroyed = false

    private var lastHeartbeatAt = Date.distantPast
    private var lastProgressPos: Double = 0
    private var lastProgressAt = Date()
    private let stallTimeoutSeconds: TimeInterval = 15
    private var recoverAttempts = 0
    // ponytail: no "sustained playback clears the counter" tracking (player.ts's
    // recoverConfirmPending) — a reload that keeps re-stalling just burns through
    // the cap faster. Add if flaky rebuffering trips the cap too eagerly.
    private let maxRecoverAttempts = 3
    private var recoveringGuard = false

    /// Fired with a fresh play URL after a lost-session / stall recovery mints
    /// a new sid — the caller reloads the AVPlayerItem at `position`.
    var onReload: ((URL, Double) -> Void)?
    /// Recovery exhausted `maxRecoverAttempts` — terminal, caller shows an error.
    var onFatalError: (() -> Void)?

    // MARK: - Start / stop

    /// `audioStreams` is the source file's own audio track list, used only to
    /// pick the master playlist's DEFAULT rendition from the user's language
    /// preference — nil/empty just lets the backend default.
    func start(
        mediaFileId: Int, mediaId: Int, episodeId: Int?, startAt: Double,
        audioStreams: [AudioStreamInfo]? = nil
    ) async throws -> URL {
        self.mediaFileId = mediaFileId
        self.mediaId = mediaId
        self.episodeId = episodeId
        destroyed = false
        recoverAttempts = 0
        let url = try await requestPlaybackInfo(startAt: startAt, audioStreams: audioStreams)
        lastProgressPos = startAt
        lastProgressAt = Date()
        return url
    }

    /// Release the live session server-side. Idempotent — safe even when no
    /// session was ever minted (matches the backend's 204-on-unknown-sid).
    func stop() {
        destroyed = true
        guard let sid = sessionId else { return }
        sessionId = nil
        Task { try? await api.delete("/api/stream/sessions/\(sid)") }
    }

    // MARK: - Playback-info + play URL

    private func requestPlaybackInfo(startAt: Double, audioStreams: [AudioStreamInfo]? = nil) async throws -> URL {
        guard let token = await AuthService.shared.ensureStreamToken() else {
            throw APIError.badStatus(401)
        }
        var query: [(String, String)] = [("token", token)]
        if startAt > 0 { query.append(("startAt", String(Int(startAt)))) }
        if let idx = DeviceProfileBuilder.preferredAudioIndex(audioStreams) {
            query.append(("audioStreamIndex", String(idx)))
        }
        let path = withQuery("/api/stream/\(mediaFileId)/playback-info", query)
        let response: PlaybackInfoResponse = try await api.post(path, body: DeviceProfileBuilder.build())
        info = response
        sessionId = response.sessionId
        return try buildStreamUrl(response, token: token, startAt: startAt)
    }

    /// The play URL is built here, not read off `response.playUrl` — every
    /// Fliks client re-derives it (token + live sid + HLS hints), same as
    /// `StreamingApiService.getHlsUrl`/`getStreamUrl` on the web client.
    private func buildStreamUrl(_ response: PlaybackInfoResponse, token: String, startAt: Double) throws -> URL {
        let path: String
        var items = [("token", token), ("sid", response.sessionId)]
        if response.playMethod == "DirectPlay" {
            path = "/api/stream/\(mediaFileId)"
        } else {
            path = "/api/stream/\(mediaFileId)/master.m3u8"
            items.append(("device", "desktop"))
            if startAt > 0 { items.append(("startAt", String(Int(startAt)))) }
        }
        guard let url = URL(string: ServerStore.shared.resolveUrl(withQuery(path, items))) else {
            throw APIError.badURL
        }
        return url
    }

    private func withQuery(_ path: String, _ items: [(String, String)]) -> String {
        guard !items.isEmpty, var comps = URLComponents(string: path) else { return path }
        comps.queryItems = (comps.queryItems ?? []) + items.map { URLQueryItem(name: $0.0, value: $0.1) }
        return comps.url?.absoluteString ?? path
    }

    // MARK: - Heartbeat (~10s, driven by the coordinator's periodic time observer)

    /// Called ~1x/sec with the live AVPlayer state. Drives the 10s heartbeat
    /// cadence and the stall watchdog off a single tick.
    func tick(position: Double, duration: Double, paused: Bool) {
        guard !destroyed, !recoveringGuard else { return }
        checkStall(position: position, paused: paused)
        guard Date().timeIntervalSince(lastHeartbeatAt) >= 10 else { return }
        sendHeartbeat(position: position, duration: duration, paused: paused)
    }

    /// Force an immediate heartbeat on a play/pause transition so the
    /// backend's LiveSession state doesn't wait for the next 10s tick.
    func notifyStateChange(position: Double, duration: Double, paused: Bool) {
        guard !destroyed else { return }
        sendHeartbeat(position: position, duration: duration, paused: paused)
    }

    /// Explicit completion heartbeat before a manual "next episode" skip — the
    /// natural end-of-file path already crosses the backend's completion
    /// threshold via the regular tick.
    func markComplete(duration: Double) {
        guard duration > 0 else { return }
        sendHeartbeat(position: duration, duration: duration, paused: true)
    }

    private func sendHeartbeat(position: Double, duration: Double, paused: Bool) {
        guard let sid = sessionId else { return }
        lastHeartbeatAt = Date()
        struct Body: Encodable {
            let positionSeconds: Double
            let durationSeconds: Double
            let mediaFileId: Int
            let episodeId: Int?
            let sessionId: String
            let state: String
        }
        struct Response: Decodable { let sessionLost: Bool? }
        let body = Body(
            positionSeconds: position, durationSeconds: duration, mediaFileId: mediaFileId,
            episodeId: episodeId, sessionId: sid, state: paused ? "paused" : "playing"
        )
        Task {
            guard let res: Response = try? await api.put("/api/playback/media/\(mediaId)/state", body: body) else { return }
            if res.sessionLost == true { await recover(position: position) }
        }
    }

    // MARK: - Stall watchdog + recovery

    private func checkStall(position: Double, paused: Bool) {
        if paused || abs(position - lastProgressPos) > 0.25 {
            lastProgressPos = position
            lastProgressAt = Date()
            return
        }
        guard Date().timeIntervalSince(lastProgressAt) >= stallTimeoutSeconds else { return }
        lastProgressAt = Date()
        Task { await recover(position: position) }
    }

    /// Called when the AVPlayerItem itself reports a hard failure (unsupported
    /// codec, manifest error AVPlayer's own HLS retry gave up on) — routes
    /// through the same one-fresh-sid-then-give-up recovery as a stall.
    func handleItemFailed(position: Double) {
        guard !destroyed else { return }
        Task { await recover(position: position) }
    }

    /// The carried sid is unknown to the backend (restart/GC) or the playhead
    /// wedged. Mint a fresh LiveSession and hand the caller a URL to reload at
    /// `position`. Retries with backoff, gives up after `maxRecoverAttempts`.
    private func recover(position: Double) async {
        guard !destroyed, !recoveringGuard else { return }
        if recoverAttempts >= maxRecoverAttempts {
            recovering = false
            onFatalError?()
            return
        }
        recoveringGuard = true
        recovering = true
        recoverAttempts += 1
        if let sid = sessionId {
            try? await api.delete("/api/stream/sessions/\(sid)")
        }
        do {
            let url = try await requestPlaybackInfo(startAt: position)
            guard !destroyed else { return }
            lastProgressPos = position
            lastProgressAt = Date()
            recovering = false
            recoveringGuard = false
            onReload?(url, position)
        } catch {
            recoveringGuard = false
            if recoverAttempts >= maxRecoverAttempts {
                recovering = false
                onFatalError?()
            } else {
                let backoffSeconds = 2 * recoverAttempts // 2s, 4s
                try? await Task.sleep(for: .seconds(backoffSeconds))
                await recover(position: position)
            }
        }
    }
}
