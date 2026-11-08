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
/// (decoded from the `karaoke-pitch` batches) are scored against the lyrics' reference melody.
@MainActor @Observable final class KaraokeSession {
    enum Phase: Equatable { case loading, unavailable, preparing(stage: String?, progress: Double?), failed, ready }

    private(set) var phase = Phase.loading
    private(set) var mode = KaraokeMode.original
    private(set) var vocalLevel: Float = 1
    private(set) var results: [SingerResult] = []
    /// The pitch class last sung by each singer, for the lane.
    private(set) var live: [Int: Double] = [:]
    var difficulty = Difficulty.medium
    /// The capture delay of the phones, in ms.
    var latencyMs = 0.0

    private let player = MusicPlayer.shared
    private let mixer = KaraokeMixer()
    private var store = FrameStore()
    private var lyrics: StructuredLyrics?
    private var loop: Task<Void, Never>?

    /// Loads the track's karaoke state, preparing it when it has no stems yet.
    func open(itemId: Int, lyrics: StructuredLyrics?) async {
        self.lyrics = lyrics
        phase = .loading
        guard await KaraokeAPI.status()?.ready == true, var state = await KaraokeAPI.state(itemId: itemId) else { return phase = .unavailable }
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
        let ok = await mixer.load { kind in
            var c = URLComponents(string: ServerStore.shared.resolveUrl("/api/media-files/\(state.fileId)/stems/\(kind.rawValue)"))
            c?.queryItems = [URLQueryItem(name: "token", value: token)]
            return c?.url
        }
        guard !Task.isCancelled else { return }
        phase = ok ? .ready : .failed
        if ok { follow() }
    }

    func setMode(_ m: KaraokeMode) {
        mode = m
        vocalLevel = m.vocalLevel
        applyMix()
    }

    func setVocalLevel(_ level: Float) {
        vocalLevel = max(0, min(1, level))
        applyMix()
    }

    /// A `karaoke-pitch` message of a singer's phone.
    func ingest(_ data: String, singerId: Int) {
        let frames = decodePitchBatch(data)
        guard !frames.isEmpty else { return }
        store.add(singerId, frames)
        live[singerId] = frames.last?.midi.map { ($0.truncatingRemainder(dividingBy: 12) + 12).truncatingRemainder(dividingBy: 12) }
        if let lyrics { results = scoreAll(lyrics, store: store, difficulty: difficulty, latencyMs: latencyMs) }
    }

    func close() {
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
