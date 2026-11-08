import Foundation

/// Scoring, pitch-frame wire and singer order, mirroring `client/src/app/core/services/karaoke/`.
enum Difficulty: String, CaseIterable {
    case easy, medium, hard

    /// Half-width of the hit window in semitones, once the octave is folded away.
    var tolerance: Double {
        switch self {
        case .easy: 2
        case .medium: 1.5
        case .hard: 0.75
        }
    }
}

enum Karaoke {
    static let goldenWeight = 2.0
    static let lineBonusRatio = 0.9
    static let maxScore = 10000.0
    static let pitchChannel = "karaoke-pitch"
    static let maxFramesPerBatch = 50
    static let guideVocalLevel: Float = 0.25
}

/// One sung frame: `t` is host media time in ms, `midi` nil when unvoiced.
struct PitchFrame: Equatable {
    var t: Double
    var midi: Double?
}

/// Distance in semitones between two notes, octave-insensitive (0...6).
func foldedDistance(_ a: Double, _ b: Double) -> Double {
    let d = abs(a - b).truncatingRemainder(dividingBy: 12)
    return min(d, 12 - d)
}

struct SingerScore: Equatable {
    var score: Int
    var lineBonus: Int
    var lines: [Double]
}

typealias ScoredLine = [StructuredLyrics.Cue]

extension StructuredLyrics {
    /// Agents that sing: a duet has two or more, a background or group agent never takes a side.
    var sides: [String] { (agents ?? []).filter { $0.role == "main" || $0.role == "voice" }.map(\.id) }

    /// Pitched cues of the lines that belong to `agentId` (every line when it is nil).
    func scoredLines(agentId: String?) -> [ScoredLine] {
        (cueLine ?? [])
            .filter { agentId == nil || ($0.agentId ?? agents?.first?.id) == agentId }
            .map { $0.cue.filter { $0.pitch != nil && $0.end > $0.start } }
            .filter { !$0.isEmpty }
    }
}

/// A cue is worth its duration (golden twice): the share of its span whose frames fall within the
/// tolerance. `offsetMs` moves the lyrics clock to the frames' one, `latencyMs` removes the capture delay;
/// 90 % of a line adds a bonus of 10 % of its worth.
func scoreSinger(_ lines: [ScoredLine], frames: [PitchFrame], difficulty: Difficulty,
                 offsetMs: Double = 0, latencyMs: Double = 0) -> SingerScore {
    let tol = difficulty.tolerance
    let sorted = frames.sorted { $0.t < $1.t }
    func worth(_ c: StructuredLyrics.Cue) -> Double { Double(c.end - c.start) * (c.golden == true ? Karaoke.goldenWeight : 1) }
    let total = lines.reduce(0) { $0 + $1.reduce(0) { $0 + worth($1) } }
    guard total > 0 else { return SingerScore(score: 0, lineBonus: 0, lines: lines.map { _ in 0 }) }
    var points = 0.0, bonus = 0.0, from = 0
    var per: [Double] = []
    for line in lines {
        var got = 0.0, max = 0.0
        for c in line {
            let a = Double(c.start) - offsetMs, b = Double(c.end) - offsetMs
            while from < sorted.count, sorted[from].t - latencyMs < a - 100 { from += 1 }
            var hit = 0, seen = 0, i = from
            while i < sorted.count, sorted[i].t - latencyMs < b {
                defer { i += 1 }
                if sorted[i].t - latencyMs < a { continue }
                seen += 1
                if let m = sorted[i].midi, foldedDistance(m, c.pitch!) <= tol { hit += 1 }
            }
            let w = worth(c)
            max += w
            if seen > 0 { got += w * Double(hit) / Double(seen) }
        }
        per.append(max == 0 ? 0 : got / max)
        points += got
        if max > 0, got / max >= Karaoke.lineBonusRatio { bonus += 0.1 * max }
    }
    let cap = total * 1.1
    return SingerScore(score: Int(((min(points + bonus, cap) / cap) * Karaoke.maxScore).rounded()),
                       lineBonus: Int(((bonus / cap) * Karaoke.maxScore).rounded()), lines: per)
}

// MARK: - Wire

/// Frames of a peer's `{k:'pf', t:[ms], m:[tenths of a semitone, -1 unvoiced]}` message; anything malformed is dropped.
func decodePitchBatch(_ data: String) -> [PitchFrame] {
    struct Batch: Decodable { let k: String; let t: [Double]; let m: [Double] }
    guard data.utf8.count <= 4096, let batch = try? JSONDecoder().decode(Batch.self, from: Data(data.utf8)),
          batch.k == "pf", batch.t.count == batch.m.count else { return [] }
    return zip(batch.t, batch.m).prefix(Karaoke.maxFramesPerBatch).compactMap { t, m in
        t.isFinite && m.isFinite && t >= 0 ? PitchFrame(t: t, midi: m < 0 ? nil : m / 10) : nil
    }
}

// MARK: - Singers

/// The frames of each singer, kept in arrival order and bounded.
struct FrameStore {
    static let maxFrames = 20000
    private var byUser: [Int: [PitchFrame]] = [:]
    private(set) var singers: [Int] = []

    mutating func add(_ userId: Int, _ frames: [PitchFrame]) {
        if byUser[userId] == nil { singers.append(userId) }
        var list = byUser[userId, default: []] + frames
        if list.count > Self.maxFrames { list.removeFirst(list.count - Self.maxFrames) }
        byUser[userId] = list
    }

    func frames(_ userId: Int) -> [PitchFrame] { byUser[userId] ?? [] }
}

struct SingerResult: Equatable {
    var userId: Int
    /// The duet side this singer takes, nil when the song is solo.
    var agentId: String?
    var score: SingerScore
}

/// Each singer against the cues of their side (the n-th singer of a duet takes the n-th agent).
func scoreAll(_ doc: StructuredLyrics, store: FrameStore, difficulty: Difficulty, latencyMs: Double) -> [SingerResult] {
    let sides = doc.sides
    let duet = sides.count >= 2 && store.singers.count >= 2
    return store.singers.enumerated().map { i, id in
        let agent = duet && i < sides.count ? sides[i] : nil
        return SingerResult(userId: id, agentId: agent,
                            score: scoreSinger(doc.scoredLines(agentId: agent), frames: store.frames(id), difficulty: difficulty,
                                               offsetMs: Double(doc.offset), latencyMs: latencyMs))
    }
}

struct QueueEntry: Equatable {
    var id: Int
    var singerId: Int
}

/// Round-robin: every singer's n-th song plays before anyone's (n+1)-th. Inside a round the singer who
/// sang least recently goes first (`lastSung`: singer id to the time of their last song), then the one
/// whose song was put forward first.
func orderQueue(_ entries: [QueueEntry], lastSung: [Int: Double] = [:]) -> [QueueEntry] {
    var rank: [Int: Int] = [:], first: [Int: Int] = [:]
    let ranked = entries.enumerated().map { i, e -> (e: QueueEntry, r: Int, i: Int) in
        let r = rank[e.singerId, default: 0]
        rank[e.singerId] = r + 1
        if first[e.singerId] == nil { first[e.singerId] = i }
        return (e, r, i)
    }
    return ranked.sorted {
        if $0.r != $1.r { return $0.r < $1.r }
        let a = lastSung[$0.e.singerId] ?? -.infinity, b = lastSung[$1.e.singerId] ?? -.infinity
        if a != b { return a < b }
        if first[$0.e.singerId]! != first[$1.e.singerId]! { return first[$0.e.singerId]! < first[$1.e.singerId]! }
        return $0.i < $1.i
    }.map(\.e)
}

// MARK: - Pitch lane

struct LaneNote {
    var start: Double
    var end: Double
    /// Pitch class 0..<12 (octave folded, fractional).
    var fold: Double
    var golden: Bool
    var agentId: String?
}

extension StructuredLyrics {
    /// Pitched cues whose span meets `[from, to]` (lyrics time, ms).
    func laneNotes(from: Double, to: Double) -> [LaneNote] {
        (cueLine ?? []).filter { Double($0.end) >= from && Double($0.start) <= to }.flatMap { l in
            l.cue.compactMap { c -> LaneNote? in
                guard let p = c.pitch, Double(c.end) > from, Double(c.start) < to else { return nil }
                return LaneNote(start: Double(c.start), end: Double(c.end), fold: (p.truncatingRemainder(dividingBy: 12) + 12).truncatingRemainder(dividingBy: 12),
                                golden: c.golden == true, agentId: l.agentId)
            }
        }
    }
}
