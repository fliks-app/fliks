import Foundation

enum KaraokeMode: String, CaseIterable {
    case original, guide, instrumental

    var labelKey: String { "karaoke.mode_\(rawValue)" }

    /// The vocal level a mode starts at; the slider moves it from there.
    var vocalLevel: Float {
        switch self {
        case .original: 1
        case .guide: Karaoke.guideVocalLevel
        case .instrumental: 0
        }
    }
}

/// Karaoke on the playing track: the stems follow the music player's clock, the singers' pitch frames
/// (relayed by the party socket) are scored against the lyrics' reference melody.
@MainActor @Observable final class KaraokeSession {
    enum Phase: Equatable { case loading, unavailable, preparing(stage: String?, progress: Double?), failed, ready }

    private(set) var phase = Phase.loading
    private(set) var mode = KaraokeMode.original
    private(set) var vocalLevel: Float = 1
    private(set) var results: [SingerResult] = []
    /// The pitch class last sung by each singer, for the lane.
    private(set) var live: [Int: Double] = [:]
    private(set) var difficulty = Difficulty(rawValue: UserDefaults.standard.string(forKey: "karaoke.difficulty") ?? "") ?? .medium
    /// The capture delay of the phones, in ms.
    private(set) var latencyMs = UserDefaults.standard.double(forKey: "karaoke.latency")
    /// The track has stems to mix; false for an MP3+G pair, which plays as it is.
    private(set) var hasStems = false
    /// The `.cdg` graphics of the track.
    private(set) var cdg: Data?
    /// False once the server cannot change the key (503).
    private(set) var keyAvailable = true
    /// True when the last calibration found too few notes to measure.
    private(set) var calibrationFailed = false
    /// True while the TV hosts a party whose phones can sing.
    private(set) var relayOpen = false

    private let player = MusicPlayer.shared
    private let mixer = KaraokeMixer()
    private var store = FrameStore()
    private var lyrics: StructuredLyrics?
    private var loop: Task<Void, Never>?
    private let relay = KaraokeRelay()

    func attach(lyrics: StructuredLyrics?) { self.lyrics = lyrics }

    /// Loads the track's karaoke state, preparing it when it has no stems yet.
    func open(itemId: Int, lyrics: StructuredLyrics?) async {
        self.lyrics = lyrics
        phase = .loading
        store.clear()
        results = []
        live = [:]
        openRelay()
        guard await KaraokeAPI.status()?.ready == true, var state = await KaraokeAPI.state(itemId: itemId) else { return phase = .unavailable }
        if state.cdg == true, let token = await player.streamToken(mediaFileId: state.fileId) {
            cdg = await fetch("/api/media-files/\(state.fileId)/cdg", token: token)
        }
        if cdg != nil, !state.hasStems { return phase = .ready }
        if !state.hasStems {
            guard let started = await KaraokeAPI.prepare(itemId: itemId) else { return phase = .unavailable }
            state = started
            while !state.hasStems, !Task.isCancelled {
                if state.state == "failed" { return phase = .failed }
                phase = .preparing(stage: state.stage, progress: state.progress)
                try? await Task.sleep(for: .seconds(2))
                guard let next = await KaraokeAPI.state(itemId: itemId) else { return phase = .failed }
                state = next
            }
        }
        guard !Task.isCancelled, let token = await player.streamToken(mediaFileId: state.fileId) else { return }
        let ok = await mixer.load { kind in self.url("/api/media-files/\(state.fileId)/stems/\(kind.rawValue)", token: token) }
        guard !Task.isCancelled else { return }
        phase = ok ? .ready : .failed
        hasStems = ok
        if ok { follow() }
    }

    private func url(_ path: String, token: String) -> URL? {
        var c = URLComponents(string: ServerStore.shared.resolveUrl(path))
        c?.queryItems = [URLQueryItem(name: "token", value: token)]
        return c?.url
    }

    private func fetch(_ path: String, token: String) async -> Data? {
        guard let url = url(path, token: token), let (data, response) = try? await URLSession.shared.data(from: url),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return data
    }

    /// Only the party host's display takes the phones' pitch frames.
    private func openRelay() {
        let party = PartyService.shared
        guard party.isHost, let id = party.party?.id else { return }
        relay.onBatch = { [weak self] id, frames in self?.ingest(frames, singerId: id) }
        relay.open(partyId: id)
        relayOpen = true
    }

    func setDifficulty(_ d: Difficulty) {
        difficulty = d
        UserDefaults.standard.set(d.rawValue, forKey: "karaoke.difficulty")
        rescore()
    }

    func setLatency(_ ms: Double) {
        latencyMs = ms
        UserDefaults.standard.set(ms, forKey: "karaoke.latency")
        rescore()
    }

    /// Sets the capture delay from the take with the most frames; false when too few notes matched.
    @discardableResult func calibrate() -> Bool {
        let best = store.singers.max { store.frames($0).count < store.frames($1).count }
        guard let lyrics, let best, let ms = lyrics.calibrate(frames: store.frames(best)) else {
            calibrationFailed = true
            return false
        }
        calibrationFailed = false
        setLatency(ms.rounded())
        return true
    }

    /// Moves the track to another key at the same position; the stems are dropped while it is not 0.
    func setKey(_ semitones: Int) async {
        let before = player.pitch
        switch await player.setPitch(semitones) {
        case .unsupported: keyAvailable = false
        case .failed: return
        case .shifted: break
        }
        guard player.pitch != before else { return }
        if player.pitch != 0 { setMode(.original) }
    }

    var key: Int { player.pitch }

    func setMode(_ m: KaraokeMode) {
        mode = m
        vocalLevel = m.vocalLevel
        applyMix()
    }

    func setVocalLevel(_ level: Float) {
        vocalLevel = max(0, min(1, level))
        applyMix()
    }

    /// A batch of a singer's phone, from the relay.
    func ingest(_ frames: [PitchFrame], singerId: Int) {
        guard !frames.isEmpty else { return }
        store.add(singerId, frames)
        live[singerId] = frames.last?.midi.map { ($0.truncatingRemainder(dividingBy: 12) + 12).truncatingRemainder(dividingBy: 12) }
        rescore()
    }

    private func rescore() {
        if let lyrics { results = scoreAll(lyrics, store: store, difficulty: difficulty, latencyMs: latencyMs) }
    }

    func close() {
        relay.close()
        relayOpen = false
        if player.pitch != 0 { Task { _ = await player.setPitch(0) } }
        loop?.cancel()
        mixer.stop()
        player.stemsActive = false
    }

    private func applyMix() {
        let stems = mode != .original && mixer.isLoaded
        player.stemsActive = stems
        mixer.setLevel(.instrumental, 1)
        mixer.setLevel(.vocals, vocalLevel)
        if !stems { mixer.pause() }
    }

    /// Keeps the stems on the player's clock: started, paused and re-seeked when the two drift apart.
    private func follow() {
        loop?.cancel()
        loop = Task { [weak self] in
            while !Task.isCancelled {
                self?.sync()
                try? await Task.sleep(for: .milliseconds(250))
            }
        }
    }

    private func sync() {
        guard mode != .original, mixer.isLoaded else { return }
        let target = player.livePosition()
        if !player.isPlaying {
            if mixer.playing { mixer.pause() }
        } else if !mixer.playing || abs(mixer.position - target) > 0.15 {
            mixer.start(at: target)
        }
    }
}
