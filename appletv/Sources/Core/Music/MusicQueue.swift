import Foundation

/// One track to play: what the pages hand to the player. `uid` tells two copies of a track apart.
struct QueueTrack: Hashable, Identifiable {
    let uid = UUID()
    let itemId: Int
    let mediaId: Int
    let title: String
    let artists: String
    let albumTitle: String
    let coverUrl: String?
    let durationSeconds: Double?
    let gain: Double?
    let peak: Double?
    let albumGain: Double?
    let albumPeak: Double?

    var id: UUID { uid }

    /// The same track, as a separate queue entry.
    func copy() -> QueueTrack {
        QueueTrack(itemId: itemId, mediaId: mediaId, title: title, artists: artists, albumTitle: albumTitle,
                   coverUrl: coverUrl, durationSeconds: durationSeconds, gain: gain, peak: peak,
                   albumGain: albumGain, albumPeak: albumPeak)
    }
}

enum RepeatMode: String, CaseIterable {
    case off, all, one

    var next: RepeatMode {
        switch self {
        case .off: .all
        case .all: .one
        case .one: .off
        }
    }
}

/// The play order of a music session. Mirrors the web `MusicQueue`.
struct MusicQueue {
    private var original: [QueueTrack] = []
    private(set) var tracks: [QueueTrack] = []
    private(set) var index = -1
    private(set) var shuffled = false
    var repeatMode: RepeatMode = .off

    var current: QueueTrack? { tracks.indices.contains(index) ? tracks[index] : nil }

    /// Every track belongs to one album, so its album gain applies.
    var singleAlbum: Bool { !tracks.isEmpty && tracks.allSatisfy { $0.mediaId == tracks[0].mediaId } }

    mutating func set(_ list: [QueueTrack], start: Int = 0, shuffle: Bool = false,
                      using rng: inout some RandomNumberGenerator) {
        original = list.map { $0.copy() }
        tracks = original
        index = tracks.isEmpty ? -1 : min(max(0, start), tracks.count - 1)
        shuffled = false
        setShuffle(shuffle, using: &rng)
    }

    mutating func set(_ list: [QueueTrack], start: Int = 0, shuffle: Bool = false) {
        var rng = SystemRandomNumberGenerator()
        set(list, start: start, shuffle: shuffle, using: &rng)
    }

    /// Shuffling keeps the current track first; turning it off restores the original order around it.
    mutating func setShuffle(_ on: Bool, using rng: inout some RandomNumberGenerator) {
        let cur = current
        shuffled = on
        guard let cur else { return }
        if on {
            var rest = tracks.filter { $0 != cur }
            rest.shuffle(using: &rng)
            tracks = [cur] + rest
            index = 0
        } else {
            let kept = Set(tracks)
            tracks = original.filter { kept.contains($0) }
            index = tracks.firstIndex(of: cur) ?? 0
        }
    }

    mutating func setShuffle(_ on: Bool) {
        var rng = SystemRandomNumberGenerator()
        setShuffle(on, using: &rng)
    }

    /// The track after the current one when playback runs on by itself.
    func peekNext() -> QueueTrack? { neighbour(1) }

    /// Moves on after a skip, or after an end (`auto`, where repeat one stays put).
    @discardableResult
    mutating func next(auto: Bool) -> QueueTrack? {
        if auto, repeatMode == .one { return current }
        guard let t = neighbour(1), let i = tracks.firstIndex(of: t) else { return nil }
        index = i
        return t
    }

    @discardableResult
    mutating func previous() -> QueueTrack? {
        guard let t = neighbour(-1), let i = tracks.firstIndex(of: t) else { return nil }
        index = i
        return t
    }

    @discardableResult
    mutating func play(at i: Int) -> QueueTrack? {
        guard tracks.indices.contains(i) else { return nil }
        index = i
        return tracks[i]
    }

    mutating func addNext(_ list: [QueueTrack]) { insert(index + 1, list) }
    mutating func addLast(_ list: [QueueTrack]) { insert(tracks.count, list) }

    /// Removing the current track leaves `current` on the one that follows it.
    mutating func remove(at i: Int) {
        guard tracks.indices.contains(i) else { return }
        let t = tracks.remove(at: i)
        original.removeAll { $0 == t }
        if i < index { index -= 1 }
        if index >= tracks.count { index = tracks.count - 1 }
    }

    mutating func clear() {
        original = []
        tracks = []
        index = -1
    }

    private func neighbour(_ step: Int) -> QueueTrack? {
        let n = tracks.count
        guard n > 0, index >= 0 else { return nil }
        let i = index + step
        if tracks.indices.contains(i) { return tracks[i] }
        return repeatMode == .all ? tracks[((i % n) + n) % n] : nil
    }

    private mutating func insert(_ at: Int, _ list: [QueueTrack]) {
        let copies = list.map { $0.copy() }
        tracks.insert(contentsOf: copies, at: min(at, tracks.count))
        if shuffled { original.append(contentsOf: copies) } else { original = tracks }
        if index < 0, !copies.isEmpty { index = 0 }
    }
}

enum ReplayGain: String, CaseIterable {
    case off, track, album

    var next: ReplayGain {
        switch self {
        case .off: .track
        case .track: .album
        case .album: .off
        }
    }

    var labelKey: String { "music_player.replay_gain_\(rawValue)" }

    var symbol: String {
        switch self {
        case .off: "speaker.slash"
        case .track: "speaker.wave.2"
        case .album: "opticaldisc"
        }
    }

    /// Linear volume of a track: never a boost (AVPlayer has no gain stage), and album gain only for one album.
    static func volume(_ mode: ReplayGain, _ t: QueueTrack, oneAlbum: Bool) -> Float {
        guard mode != .off else { return 1 }
        let album = mode == .album && oneAlbum && t.albumGain != nil
        guard let gain = album ? t.albumGain : t.gain else { return 1 }
        var factor = pow(10, gain / 20)
        if let peak = album ? t.albumPeak : t.peak, peak > 0, factor * peak > 1 { factor = 1 / peak }
        return Float(min(1, factor))
    }
}
