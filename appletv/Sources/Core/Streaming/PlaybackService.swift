import AVFoundation
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
    /// Position in the source's audio list of the track the session plays: the one
    /// requested at start, then whatever the viewer switched to. Nil when unknown.
    private(set) var audioStreamIndex: Int?
    /// The subtitle the settings select for the item: decided before the first playback-info call,
    /// which carries it (burn-in id, HLS renditions), and kept by every recovery reload.
    private(set) var subtitlePick: SubtitlePick?
    /// Active rung: the persisted pick at start, then whatever the backend reports for the session.
    private(set) var qualityId = "auto"

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

    /// The item being played, read for the heartbeat's `qoe` block. Set by the coordinator on every (re)load.
    weak var qoeItem: AVPlayerItem?
    private var stallCount = 0
    private var stallMs = 0
    private var recoveryReloads = 0
    private var pendingEvents: [QoeEvent] = []

    struct QoeEvent: Encodable {
        let type: String
        let at: Int
        let position: Double?
        var durationMs: Int?
        var bufferAheadS: Double?
        var bandwidthBps: Double?
        var message: String?
    }

    /// Fired with a fresh play URL after a lost-session / stall recovery mints
    /// a new sid — the caller reloads the AVPlayerItem at `position`.
    var onReload: ((URL, Double) -> Void)?
    /// Recovery exhausted `maxRecoverAttempts` — terminal, caller shows an error.
    var onFatalError: (() -> Void)?

    // MARK: - Start / stop

    /// `streamInfo` is the source file's own track list: the viewer's audio preferences pick
    /// the master playlist's DEFAULT rendition, and with `subtitleRows` the subtitle to show.
    func start(
        mediaFileId: Int, mediaId: Int, episodeId: Int?, startAt: Double,
        streamInfo: MediaFileInfo?, subtitleRows: [SubtitleFileRow]
    ) async throws -> URL {
        self.mediaFileId = mediaFileId
        self.mediaId = mediaId
        self.episodeId = episodeId
        destroyed = false
        recoverAttempts = 0
        stallCount = 0; stallMs = 0; recoveryReloads = 0; pendingEvents = []
        let settings = AppSettingsStore.shared
        qualityId = settings.playerQualityId
        let audio = streamInfo?.audio ?? []
        audioStreamIndex = TrackSelection.audioIndex(
            in: audio, preferredLanguage: settings.preferredAudioLanguage,
            useDefault: settings.useDefaultAudioStream, remembered: settings.rememberedAudio(for: mediaId)
        )
        let rows = subtitleRows.filter { $0.mediaFileId == mediaFileId }
        subtitlePick = TrackSelection.autoSubtitle(
            mode: settings.subtitleMode, preferredLanguage: settings.preferredSubtitleLanguage,
            audioLanguage: audioStreamIndex.flatMap { TrackSelection.canonicalLanguage(audio[$0].language) },
            text: TrackSelection.subtitleTracks(embedded: streamInfo?.subtitles ?? [], external: rows),
            bitmap: TrackSelection.bitmapSubtitleTracks(rows),
            remembered: settings.rememberedSubtitle(for: mediaId)
        )
        let url = try await requestPlaybackInfo(startAt: startAt)
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

    // MARK: - Quality

    /// "Auto" + the server's rungs, minus the eco ones when the setting hides them
    /// (web QualityManagerService.buildQualityOptions).
    var qualityOptions: [QualityOption] {
        let auto = QualityOption(id: "auto", label: tr("player.auto"), height: 0, width: nil,
                                 totalBitrateBps: 0, isRemux: false, lowBandwidth: nil)
        let showEco = AppSettingsStore.shared.showEcoQualities
        return [auto] + (info?.qualities ?? []).filter { showEco || $0.lowBandwidth != true }
    }

    /// Re-negotiates at the chosen rung through the recovery path, so position,
    /// audio and subtitle carry over via `onReload`.
    func selectQuality(_ id: String, position: Double) {
        guard !destroyed, !recoveringGuard, id != qualityId else { return }
        qualityId = id
        AppSettingsStore.shared.playerQualityId = id
        recoverAttempts = 0
        Task { await recover(position: position, countAsRecovery: false) }
    }

    // MARK: - Playback-info + play URL

    private func requestPlaybackInfo(startAt: Double) async throws -> URL {
        guard let token = await AuthService.shared.ensureStreamToken() else {
            throw APIError.badStatus(401)
        }
        var query: [(String, String)] = [("token", token)]
        if startAt > 0 { query.append(("startAt", String(Int(startAt)))) }
        if let audioStreamIndex { query.append(("audioStreamIndex", String(audioStreamIndex))) }
        if qualityId != "auto" { query.append(("startQuality", qualityId)) }
        var needsHlsSubtitles = false
        switch subtitlePick {
        case .burnIn(let id)?: query.append(("burnInSubtitleId", String(id)))
        case .text?: needsHlsSubtitles = AuthService.shared.hasServerFeature("hlsSubtitleRequest")
        case nil: break
        }
        let path = withQuery("/api/stream/\(mediaFileId)/playback-info", query)
        let response: PlaybackInfoResponse = try await api.post(
            path,
            body: DeviceProfileBuilder.build(
                needsHlsSubtitles: needsHlsSubtitles,
                supportsMuxedAudioRendition: AuthService.shared.hasServerFeature("muxedAudioRendition")
            )
        )
        info = response
        sessionId = response.sessionId
        if let quality = response.quality { qualityId = quality }
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
            if qualityId != "auto", !response.playUrl.contains("remux=1") { items.append(("startQuality", qualityId)) }
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

    /// Set by `PlayerCoordinator.applyRemoteCommand`: reported on the next
    /// heartbeat as `lastCmdId`, the semantic ack a remote controller waits on.
    private var lastCmdId: String?

    /// Called ~1x/sec with the live AVPlayer state. Drives the 10s heartbeat
    /// cadence and the stall watchdog off a single tick.
    func tick(position: Double, duration: Double, paused: Bool,
              audioTrackIndex: Int? = nil, subtitleTrackIndex: Int? = nil, subtitleId: String? = nil) {
        guard !destroyed, !recoveringGuard else { return }
        if let audioTrackIndex { audioStreamIndex = audioTrackIndex }
        checkStall(position: position, paused: paused)
        guard Date().timeIntervalSince(lastHeartbeatAt) >= 10 else { return }
        sendHeartbeat(position: position, duration: duration, paused: paused, audioTrackIndex: audioTrackIndex,
                      subtitleTrackIndex: subtitleTrackIndex, subtitleId: subtitleId)
    }

    /// Force an immediate heartbeat on a play/pause transition (or an applied
    /// remote command, via `lastCmdId`) so the backend's LiveSession state
    /// doesn't wait for the next 10s tick.
    func notifyStateChange(position: Double, duration: Double, paused: Bool,
                           audioTrackIndex: Int? = nil, subtitleTrackIndex: Int? = nil, subtitleId: String? = nil,
                           lastCmdId: String? = nil) {
        guard !destroyed else { return }
        if let lastCmdId { self.lastCmdId = lastCmdId }
        if let audioTrackIndex { audioStreamIndex = audioTrackIndex }
        sendHeartbeat(position: position, duration: duration, paused: paused, audioTrackIndex: audioTrackIndex,
                      subtitleTrackIndex: subtitleTrackIndex, subtitleId: subtitleId)
    }

    /// Explicit completion heartbeat before a manual "next episode" skip — the
    /// natural end-of-file path already crosses the backend's completion
    /// threshold via the regular tick.
    func markComplete(duration: Double) {
        guard duration > 0 else { return }
        sendHeartbeat(position: duration, duration: duration, paused: true)
    }

    private func sendHeartbeat(position: Double, duration: Double, paused: Bool,
                               audioTrackIndex: Int? = nil, subtitleTrackIndex: Int? = nil, subtitleId: String? = nil) {
        guard let sid = sessionId else { return }
        lastHeartbeatAt = Date()
        /// Encodes nil as JSON null: synthesized Encodable omits it, which the backend reads as "unchanged".
        struct Nullable: Encodable {
            let value: String?
            func encode(to encoder: Encoder) throws {
                var container = encoder.singleValueContainer()
                try container.encode(value)
            }
        }
        struct Rung: Encodable {
            let id: String
            let label: String
            let lowBandwidth: Bool?
        }
        struct Body: Encodable {
            let positionSeconds: Double
            let durationSeconds: Double
            let mediaFileId: Int
            let episodeId: Int?
            let sessionId: String
            let state: String
            let audioTrackIndex: Int?
            let subtitleTrackIndex: Int?
            let subtitleId: Nullable
            let lastCmdId: String?
            let quality: String
            let qualities: [Rung]
            // Links a polled remote target to this live session; nil until registered.
            let targetId: String?
            let qoe: Qoe
        }
        struct Response: Decodable { let sessionLost: Bool? }
        let body = Body(
            positionSeconds: position, durationSeconds: duration, mediaFileId: mediaFileId,
            episodeId: episodeId, sessionId: sid, state: paused ? "paused" : "playing",
            audioTrackIndex: audioTrackIndex, subtitleTrackIndex: subtitleTrackIndex,
            subtitleId: Nullable(value: subtitleId), lastCmdId: lastCmdId,
            quality: qualityId,
            qualities: qualityOptions.map { Rung(id: $0.id, label: $0.label, lowBandwidth: $0.lowBandwidth) },
            targetId: RemoteControlService.shared.targetId,
            qoe: qoeSample()
        )
        let events = takeEvents()
        Task {
            await postEvents(events, sid: sid)
            guard let res: Response = try? await api.put("/api/playback/media/\(mediaId)/state", body: body) else { return }
            if res.sessionLost == true { await recover(position: position) }
        }
    }

    // MARK: - QoE

    struct Qoe: Encodable {
        let engine = "avplayer"
        let cmcd: Bool
        let droppedFrames: Int?
        let decodedFrames: Int?
        let bandwidthBps: Double?
        let bufferAheadS: Double?
        let variantBitrate: Double?
        let width: Int?
        let height: Int?
        let videoCodec: String?
        let decoderName: String?
        let hwDecoder = true
        let stallCount: Int
        let stallMs: Int
        let recoveryReloads: Int
    }

    private var bandwidth: Double? {
        qoeItem?.accessLog()?.events.last.flatMap { $0.observedBitrate > 0 ? $0.observedBitrate : nil }
    }

    private var bufferAhead: Double? {
        guard let item = qoeItem else { return nil }
        let now = item.currentTime()
        return item.loadedTimeRanges.map(\.timeRangeValue).first { $0.containsTime(now) }
            .map { max(CMTimeGetSeconds($0.end) - now.seconds, 0) }
    }

    private func qoeSample() -> Qoe {
        let events = qoeItem?.accessLog()?.events ?? []
        let size = qoeItem?.presentationSize ?? .zero
        var cmcd = false
        if #available(tvOS 18.0, *) { cmcd = true }
        return Qoe(
            cmcd: cmcd,
            droppedFrames: events.isEmpty ? nil : events.map(\.numberOfDroppedVideoFrames).filter { $0 >= 0 }.reduce(0, +),
            decodedFrames: nil, bandwidthBps: bandwidth, bufferAheadS: bufferAhead,
            variantBitrate: events.last.flatMap { $0.indicatedBitrate > 0 ? $0.indicatedBitrate : nil },
            width: size.width > 0 ? Int(size.width) : nil, height: size.height > 0 ? Int(size.height) : nil,
            videoCodec: nil, decoderName: nil,
            stallCount: stallCount, stallMs: stallMs, recoveryReloads: recoveryReloads
        )
    }

    /// A rebuffer that ended where it began (the coordinator drops seeks).
    func recordStall(position: Double, durationMs: Int) {
        stallCount += 1
        stallMs += durationMs
        pendingEvents.append(QoeEvent(type: "stall", at: Int(Date().timeIntervalSince1970 * 1000), position: position,
                                      durationMs: durationMs, bufferAheadS: bufferAhead, bandwidthBps: bandwidth))
    }

    private func recordEvent(_ type: String, position: Double, message: String? = nil) {
        pendingEvents.append(QoeEvent(type: type, at: Int(Date().timeIntervalSince1970 * 1000), position: position,
                                      bufferAheadS: bufferAhead, bandwidthBps: bandwidth, message: message))
    }

    private func takeEvents() -> [QoeEvent] {
        defer { pendingEvents = [] }
        return pendingEvents
    }

    private func postEvents(_ events: [QoeEvent], sid: String) async {
        struct Body: Encodable { let events: [QoeEvent] }
        guard !events.isEmpty else { return }
        try? await api.post("/api/playback/sessions/\(sid)/events", body: Body(events: events))
    }

    private func flushNow() {
        guard let sid = sessionId else { return }
        let events = takeEvents()
        Task { await postEvents(events, sid: sid) }
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
        recordEvent("error", position: position, message: qoeItem?.error?.localizedDescription)
        flushNow()
        Task { await recover(position: position) }
    }

    /// The carried sid is unknown to the backend (restart/GC) or the playhead
    /// wedged. Mint a fresh LiveSession and hand the caller a URL to reload at
    /// `position`. Retries with backoff, gives up after `maxRecoverAttempts`.
    private func recover(position: Double, countAsRecovery: Bool = true) async {
        guard !destroyed, !recoveringGuard else { return }
        if recoverAttempts >= maxRecoverAttempts {
            recovering = false
            recordEvent("error", position: position, message: "recovery exhausted")
            flushNow()
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
            if countAsRecovery {
                recoveryReloads += 1
                recordEvent("recovery", position: position)
            }
            onReload?(url, position)
        } catch {
            recoveringGuard = false
            if recoverAttempts >= maxRecoverAttempts {
                recovering = false
                onFatalError?()
            } else {
                let backoffSeconds = 2 * recoverAttempts // 2s, 4s
                try? await Task.sleep(for: .seconds(backoffSeconds))
                await recover(position: position, countAsRecovery: countAsRecovery)
            }
        }
    }
}
