import AVFoundation
import Foundation
import MediaPlayer
import UIKit

/// What a controller (the screen, a Siri Remote key) asks of the player.
enum MusicTransport: Equatable {
    case play, pause, seek(Double), next, previous
}

/// The music player: an AVQueuePlayer holding the playing and the next track for a gapless hand-over,
/// a stream session and file-bound token per track, and beats to the server like the other clients.
@MainActor @Observable final class MusicPlayer {
    static let shared = MusicPlayer()

    private(set) var queue = MusicQueue()
    private(set) var isPlaying = false
    private(set) var isBuffering = false
    private(set) var position: Double = 0
    private(set) var duration: Double = 0
    /// A failure worth a line on screen.
    private(set) var notice: String?
    var replayGain: ReplayGain {
        didSet {
            UserDefaults.standard.set(replayGain.rawValue, forKey: "music.replayGain")
            applyGain()
        }
    }

    /// The karaoke stems carry the sound: the track's own audio stays silent but keeps the clock.
    var stemsActive = false {
        didSet { applyGain() }
    }

    /// The playing track's key change in semitones; 0 outside karaoke and on any other track.
    var pitch: Int { current?.uid == pitchedUid ? pitchSemitones : 0 }

    /// The Now Playing page is on screen: a second push is not needed.
    @ObservationIgnored var nowPlayingOpen = false

    var current: QueueTrack? { queue.current }
    var shuffled: Bool { queue.shuffled }
    var repeatMode: RepeatMode { queue.repeatMode }

    /// A party drives the audio: transport keys become intents. Returns true when it took the request.
    @ObservationIgnored var intercept: ((MusicTransport) -> Bool)?
    /// The player moved to another track, or stopped: the party follows it.
    @ObservationIgnored var onTrackChange: ((QueueTrack?) -> Void)?
    /// The playing track ended by itself and nothing follows it.
    @ObservationIgnored var onTrackEnded: ((QueueTrack) -> Void)?

    private struct Resolved {
        let path: String
        var sessionId: String?
        let mediaFileId: Int
    }

    private enum StreamFailure: Error {
        case notPlayable
        case unavailable
    }

    private struct Info: Decodable {
        struct Part: Decodable { let playUrl: String? }
        let sessionId: String
        let mediaFileId: Int
        let playMethod: String
        let playUrl: String
        let parts: [Part]?
    }

    @ObservationIgnored private let api = APIClient.shared
    @ObservationIgnored private let player = AVQueuePlayer()
    @ObservationIgnored private var uidOfItem: [ObjectIdentifier: UUID] = [:]
    @ObservationIgnored private var resolved: [Int: Resolved] = [:]
    @ObservationIgnored private var streamTokens: [Int: (token: String, expiresAt: Date)] = [:]
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var pitchSemitones = 0
    @ObservationIgnored private var pitchedUid: UUID?
    @ObservationIgnored private var loading = false
    @ObservationIgnored private var ended = false
    @ObservationIgnored private var lastItem: ObjectIdentifier?
    @ObservationIgnored private var recoveredUid: UUID?
    @ObservationIgnored private var positionStamp = Date()
    @ObservationIgnored private var lastBeat = Date.distantPast
    @ObservationIgnored private var artwork: (uid: UUID, art: MPMediaItemArtwork)?
    @ObservationIgnored private var observers: [NSKeyValueObservation] = []
    @ObservationIgnored private var noticeTask: Task<Void, Never>?

    private static let beatInterval: TimeInterval = 15

    private init() {
        replayGain = UserDefaults.standard.string(forKey: "music.replayGain").flatMap(ReplayGain.init) ?? .track
        player.automaticallyWaitsToMinimizeStalling = true
        player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        observers.append(player.observe(\.currentItem, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in self?.currentItemChanged() }
        })
        observers.append(player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in self?.statusChanged() }
        })
        NotificationCenter.default.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: nil, queue: .main) { [weak self] note in
            guard let item = note.object as? AVPlayerItem else { return }
            Task { @MainActor in self?.itemEnded(item) }
        }
        registerRemoteCommands()
    }

    // MARK: - Controls

    /// Replaces the queue and starts it at `start`.
    func play(_ tracks: [QueueTrack], from start: Int = 0, shuffle: Bool = false) {
        guard !tracks.isEmpty else { return }
        queue.set(tracks, start: start, shuffle: shuffle)
        begin(startAt: 0, autoplay: true)
    }

    func perform(_ transport: MusicTransport) {
        if intercept?(transport) == true { return }
        apply(transport)
    }

    /// The transport without the party's say: what a party applies to this device.
    func apply(_ transport: MusicTransport) {
        switch transport {
        case .play: resume()
        case .pause: player.pause()
        case .seek(let seconds): seek(to: seconds)
        case .next: skip(forward: true)
        case .previous: skip(forward: false)
        }
    }

    /// The current track is loaded and can play at once.
    var itemReady: Bool { !loading && player.currentItem?.status == .readyToPlay }
    /// The position now, between two ticks of `position`.
    func livePosition(at date: Date = Date()) -> Double {
        isPlaying ? position + date.timeIntervalSince(positionStamp) * Double(player.rate) : position
    }

    var currentRate: Float { player.rate }

    /// A small rate change a party uses to close a drift.
    func setRate(_ rate: Float) {
        player.defaultRate = rate
        if player.rate != 0 { player.rate = rate }
    }

    enum PitchOutcome { case shifted, unsupported, failed }

    /// Re-opens the playing track in another key (clamped to +-12) at the same position. Nothing changes
    /// unless it answers `.shifted`; `.unsupported` is the engine lacking `pitch-shift` (503).
    func setPitch(_ semitones: Int) async -> PitchOutcome {
        let n = max(-12, min(12, semitones))
        guard let track = current, !loading else { return .failed }
        guard n != pitch else { return .shifted }
        let position = livePosition()
        let autoplay = isPlaying
        let old = resolved[track.itemId]
        resolved[track.itemId] = nil
        let result = await resolve(itemId: track.itemId, pitch: n, at: position)
        guard case .success = result, track.uid == current?.uid else {
            resolved[track.itemId] = old
            if case .failure(.notPlayable) = result { return .unsupported }
            return .failed
        }
        if let sid = old?.sessionId { end(session: sid) }
        pitchSemitones = n
        pitchedUid = n == 0 ? nil : track.uid
        begin(startAt: position, autoplay: autoplay)
        return .shifted
    }

    func togglePlayPause() { perform(isPlaying || isBuffering ? .pause : .play) }

    /// Starts the track `track` alone, paused or not, at `startAt`: how a party opens its item.
    func open(_ track: QueueTrack, startAt: Double = 0, autoplay: Bool) {
        queue.set([track])
        begin(startAt: startAt, autoplay: autoplay)
    }

    func skip(to index: Int) {
        guard queue.play(at: index) != nil else { return }
        begin(startAt: 0, autoplay: true)
    }

    func toggleShuffle() {
        queue.setShuffle(!queue.shuffled)
        queueChanged()
    }

    func cycleRepeat() {
        queue.repeatMode = queue.repeatMode.next
        queueChanged()
    }

    func addNext(_ tracks: [QueueTrack]) {
        if current == nil { return play(tracks) }
        queue.addNext(tracks)
        queueChanged()
    }

    func addLast(_ tracks: [QueueTrack]) {
        if current == nil { return play(tracks) }
        queue.addLast(tracks)
        queueChanged()
    }

    func remove(at index: Int) {
        let wasCurrent = index == queue.index
        queue.remove(at: index)
        if wasCurrent { queue.current == nil ? stop() : begin(startAt: 0, autoplay: isPlaying) } else { queueChanged() }
    }

    func stop() {
        guard current != nil || !resolved.isEmpty else { return }
        beat(state: "paused")
        generation += 1
        loading = false
        player.pause()
        player.removeAllItems()
        uidOfItem = [:]
        lastItem = nil
        endSessions(keeping: [])
        streamTokens = [:]
        queue.clear()
        position = 0
        duration = 0
        isPlaying = false
        isBuffering = false
        publishNowPlaying()
        onTrackChange?(nil)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func resume() {
        guard current != nil else { return }
        if ended || player.currentItem == nil, !loading {
            begin(startAt: 0, autoplay: true)
            return
        }
        activateSession()
        player.play()
    }

    private func seek(to seconds: Double) {
        let target = max(0, duration > 0 ? min(seconds, duration) : seconds)
        player.seek(to: CMTime(seconds: target, preferredTimescale: 1000), toleranceBefore: .zero, toleranceAfter: .zero)
        position = target
        ended = false
        beat()
        publishNowPlaying()
    }

    /// Previous restarts a track past its first seconds, like the other players.
    private func skip(forward: Bool) {
        if forward {
            guard queue.next(auto: false) != nil else { return stopAtEnd() }
            begin(startAt: 0, autoplay: true)
        } else if position > 3 || queue.previous() == nil {
            seek(to: 0)
        } else {
            begin(startAt: 0, autoplay: true)
        }
    }

    private func stopAtEnd() {
        player.pause()
        seek(to: 0)
    }

    // MARK: - Queue

    /// Replaces the player's items with the current track, then lines up the next one.
    private func begin(startAt: Double, autoplay: Bool) {
        guard let track = current else { return }
        generation += 1
        let mine = generation
        ended = false
        loading = true
        lastItem = nil
        player.pause()
        player.removeAllItems()
        uidOfItem = [:]
        activateSession()
        position = startAt
        duration = track.durationSeconds ?? 0
        publishNowPlaying()
        Task {
            guard let (item, index) = await makeItem(from: queue.index), mine == generation else {
                if mine == generation { loading = false; fail(tr("music.load_failed")) }
                return
            }
            queue.play(at: index)
            uidOfItem[ObjectIdentifier(item)] = queue.tracks[index].uid
            player.insert(item, after: nil)
            loading = false
            if startAt > 0 {
                await player.seek(to: CMTime(seconds: startAt, preferredTimescale: 1000), toleranceBefore: .zero, toleranceAfter: .zero)
            }
            if autoplay { player.play() }
            currentItemChanged()
        }
    }

    /// A queue edit while playing: the lined-up track is dropped and picked again.
    private func queueChanged() {
        for item in player.items().dropFirst() { player.remove(item) }
        prefetchNext()
        publishNowPlaying()
    }

    private func nextTrack() -> QueueTrack? { queue.repeatMode == .one ? current : queue.peekNext() }

    private func prefetchNext() {
        guard player.items().count < 2, let next = nextTrack(),
              let index = queue.tracks.firstIndex(of: next) else { return }
        let mine = generation
        let uid = current?.uid
        Task {
            guard case .success(let item) = await makeItem(index), mine == generation, uid == current?.uid,
                  player.items().count < 2 else { return }
            uidOfItem[ObjectIdentifier(item)] = queue.tracks[index].uid
            player.insert(item, after: player.items().last)
        }
    }

    private func makeItem(from start: Int) async -> (AVPlayerItem, Int)? {
        guard case .success(let item) = await makeItem(start) else { return nil }
        return (item, start)
    }

    private func makeItem(_ i: Int) async -> Result<AVPlayerItem, StreamFailure> {
        guard queue.tracks.indices.contains(i) else { return .failure(.unavailable) }
        let track = queue.tracks[i]
        switch await resolve(itemId: track.itemId, pitch: track.uid == pitchedUid ? pitchSemitones : 0) {
        case .failure(let failure):
            return .failure(failure)
        case .success(let r):
            guard let url = await streamUrl(r) else { return .failure(.unavailable) }
            let item = AVPlayerItem(url: url)
            item.audioTimePitchAlgorithm = .timeDomain
            return .success(item)
        }
    }

    // MARK: - Streams

    /// DirectPlay streams the file; any other decision (a key change included) plays the item's HLS timeline.
    private func resolve(itemId: Int, pitch: Int = 0, at startAt: Double = 0) async -> Result<Resolved, StreamFailure> {
        if let known = resolved[itemId] { return .success(known) }
        do {
            let query = pitch == 0 ? "startAt=0" : "startAt=\(startAt)&pitchSemitones=\(pitch)"
            let info: Info = try await api.post("/api/items/\(itemId)/playback-info?\(query)", body: DeviceProfileBuilder.buildMusic())
            var path = Self.streamPath(playMethod: info.playMethod, pitched: pitch != 0, partUrl: info.parts?.first?.playUrl, playUrl: info.playUrl)
            if let q = path.firstIndex(of: "?") { path = String(path[..<q]) }
            let r = Resolved(path: path, sessionId: info.sessionId, mediaFileId: info.mediaFileId)
            resolved[itemId] = r
            return .success(r)
        } catch APIError.badStatus(503, _) where pitch != 0 {
            return .failure(.notPlayable)
        } catch {
            return .failure(.unavailable)
        }
    }

    /// The file's byte-range URL for a DirectPlay answer, the item's HLS URL for any other decision.
    nonisolated static func streamPath(playMethod: String, pitched: Bool, partUrl: String?, playUrl: String) -> String {
        playMethod == "DirectPlay" && !pitched ? partUrl ?? playUrl : playUrl
    }

    /// A stream token bound to one media file, reused while it has 30 min of life left.
    func streamToken(mediaFileId: Int) async -> String? {
        struct Minted: Decodable { let streamToken: String; let expiresAt: Double }
        if let known = streamTokens[mediaFileId], known.expiresAt.timeIntervalSinceNow > 30 * 60 { return known.token }
        guard let minted: Minted = try? await api.post("/api/auth/stream-token", body: ["mediaFileId": mediaFileId]) else { return nil }
        streamTokens[mediaFileId] = (minted.streamToken, Date(timeIntervalSince1970: minted.expiresAt / 1000))
        return minted.streamToken
    }

    /// The stream URL, bound to its file by a stream token reused while it has 30 min of life left.
    private func streamUrl(_ r: Resolved) async -> URL? {
        let token = await streamToken(mediaFileId: r.mediaFileId)
        guard token != nil else { return nil }
        var comps = URLComponents(string: ServerStore.shared.resolveUrl(r.path))
        comps?.queryItems = [URLQueryItem(name: "token", value: token)]
            + (r.sessionId.map { [URLQueryItem(name: "sid", value: $0)] } ?? [])
        return comps?.url
    }

    /// Ends the sessions of tracks that are neither playing nor lined up.
    private func endSessions(keeping keep: [Int]) {
        for (id, r) in resolved where !keep.contains(id) {
            resolved[id] = nil
            if let sid = r.sessionId { end(session: sid) }
        }
    }

    private func end(session sid: String) {
        guard let encoded = sid.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else { return }
        Task { try? await api.delete("/api/stream/sessions/\(encoded)") }
    }

    // MARK: - Player events

    private func tick() {
        guard let item = player.currentItem else { return }
        if player.timeControlStatus == .playing { position = max(player.currentTime().seconds, 0); positionStamp = Date() }
        let d = item.duration.seconds
        if d.isFinite, d > 0, abs(d - duration) > 0.5 { duration = d; publishNowPlaying() }
        if isPlaying, Date().timeIntervalSince(lastBeat) >= Self.beatInterval { beat() }
    }

    private func statusChanged() {
        let status = player.timeControlStatus
        isPlaying = status == .playing
        isBuffering = status == .waitingToPlayAtSpecifiedRate && player.currentItem != nil
        if status == .playing { recoveredUid = nil }
        if current != nil, !loading { beat() }
        publishNowPlaying()
    }

    /// The item the player moved on to becomes the current track and the next one is lined up.
    private func currentItemChanged() {
        guard let item = player.currentItem else {
            if current != nil, !loading, !ended {
                ended = true
                isPlaying = false
                position = 0
                publishNowPlaying()
                if let last = current { onTrackEnded?(last) }
            }
            return
        }
        let id = ObjectIdentifier(item)
        guard id != lastItem, let uid = uidOfItem[id] else { return }
        lastItem = id
        itemStatusObserver = item.observe(\.status, options: [.new]) { [weak self] item, _ in
            guard item.status == .failed else { return }
            Task { @MainActor in self?.recover(item) }
        }
        if let i = queue.tracks.firstIndex(where: { $0.uid == uid }) { queue.play(at: i) }
        let live = Set(player.items().map(ObjectIdentifier.init))
        uidOfItem = uidOfItem.filter { live.contains($0.key) }
        position = 0
        duration = current?.durationSeconds ?? 0
        applyGain()
        prefetchNext()
        let keep = [current?.itemId, nextTrack()?.itemId].compactMap { $0 }
        endSessions(keeping: keep)
        beat()
        publishNowPlaying()
        onTrackChange?(current)
    }

    @ObservationIgnored private var itemStatusObserver: NSKeyValueObservation?

    /// A track that ran to its end reports its last position, which the finish rule counts as a play.
    private func itemEnded(_ item: AVPlayerItem) {
        guard let uid = uidOfItem[ObjectIdentifier(item)], let track = queue.tracks.first(where: { $0.uid == uid }) else { return }
        let d = item.duration.seconds
        beat(track, position: d.isFinite && d > 0 ? d : (track.durationSeconds ?? position), state: "paused")
    }

    /// The current item failed to load (a stream URL outlived its token while paused): rebuilt once at the same spot.
    private func recover(_ item: AVPlayerItem) {
        guard item === player.currentItem, let track = current, recoveredUid != track.uid else {
            fail(tr("music.load_failed"))
            return
        }
        recoveredUid = track.uid
        if let r = resolved.removeValue(forKey: track.itemId) {
            if let sid = r.sessionId { end(session: sid) }
            streamTokens[r.mediaFileId] = nil
        }
        begin(startAt: max(player.currentTime().seconds, 0), autoplay: player.timeControlStatus != .paused)
    }

    private func fail(_ text: String) {
        notice = text
        noticeTask?.cancel()
        noticeTask = Task {
            try? await Task.sleep(for: .seconds(5))
            if !Task.isCancelled { notice = nil }
        }
    }

    // MARK: - Beats

    private struct Beat: Encodable {
        let positionSeconds: Double
        let durationSeconds: Double
        let mediaFileId: Int
        let itemId: Int
        let sessionId: String?
        let state: String
    }

    private struct BeatAnswer: Decodable { let sessionLost: Bool? }

    /// One state beat for `track` (the current one by default): the server derives plays and history.
    private func beat(_ track: QueueTrack? = nil, position at: Double? = nil, state: String? = nil) {
        guard let track = track ?? current, let r = resolved[track.itemId] else { return }
        lastBeat = Date()
        let body = Beat(positionSeconds: at ?? position, durationSeconds: duration > 0 ? duration : (track.durationSeconds ?? 0),
                        mediaFileId: r.mediaFileId, itemId: track.itemId, sessionId: r.sessionId,
                        state: state ?? (isPlaying ? "playing" : "paused"))
        Task {
            let answer: BeatAnswer? = try? await api.put("/api/playback/media/\(track.mediaId)/state", body: body)
            if answer?.sessionLost == true { resolved[track.itemId]?.sessionId = nil }
        }
    }

    // MARK: - Gain and audio session

    private func applyGain() {
        guard let track = current else { return }
        player.volume = stemsActive ? 0 : ReplayGain.volume(replayGain, track, oneAlbum: queue.singleAlbum)
    }

    private func activateSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default)
        try? session.setActive(true)
    }

    // MARK: - Now Playing and Siri Remote

    private func publishNowPlaying() {
        let center = MPNowPlayingInfoCenter.default()
        let commands = MPRemoteCommandCenter.shared()
        let has = current != nil
        for c in [commands.playCommand, commands.pauseCommand, commands.togglePlayPauseCommand,
                  commands.nextTrackCommand, commands.previousTrackCommand, commands.changePlaybackPositionCommand] {
            c.isEnabled = has
        }
        guard let t = current else {
            center.nowPlayingInfo = nil
            center.playbackState = .stopped
            return
        }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: t.title,
            MPMediaItemPropertyArtist: t.artists,
            MPMediaItemPropertyAlbumTitle: t.albumTitle,
            MPMediaItemPropertyPlaybackDuration: duration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: position,
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? 1.0 : 0.0,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
        ]
        if let art = artwork, art.uid == t.uid { info[MPMediaItemPropertyArtwork] = art.art }
        center.nowPlayingInfo = info
        center.playbackState = isPlaying ? .playing : .paused
        if artwork?.uid != t.uid { loadArtwork(for: t) }
    }

    private func loadArtwork(for t: QueueTrack) {
        guard let str = ImageURL.build(t.coverUrl, size: .medium), let url = URL(string: str) else { return }
        Task {
            guard let image = await ImageCache.load(url), current?.uid == t.uid else { return }
            artwork = (t.uid, MPMediaItemArtwork(boundsSize: image.size) { _ in image })
            publishNowPlaying()
        }
    }

    private func registerRemoteCommands() {
        let c = MPRemoteCommandCenter.shared()
        func bind(_ command: MPRemoteCommand, _ transport: MusicTransport) {
            command.addTarget { [weak self] _ in
                Task { @MainActor in self?.perform(transport) }
                return .success
            }
        }
        bind(c.playCommand, .play)
        bind(c.pauseCommand, .pause)
        bind(c.nextTrackCommand, .next)
        bind(c.previousTrackCommand, .previous)
        c.togglePlayPauseCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.togglePlayPause() }
            return .success
        }
        c.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            Task { @MainActor in self?.perform(.seek(event.positionTime)) }
            return .success
        }
        for command in [c.playCommand, c.pauseCommand, c.togglePlayPauseCommand, c.nextTrackCommand,
                        c.previousTrackCommand, c.changePlaybackPositionCommand] {
            command.isEnabled = false
        }
    }
}
