import Foundation

/// Port of client/src/app/core/utils/edl-policy.ts, keep in sync.
struct EdlPolicy {
    static let commercialTail = 1.0
    static let eofSlack = 0.05
    static let muteMergeGap = 0.2
    /// A position this close to a range end is outside it (a seek can land a hair short).
    static let edgeEps = 0.01
    /// Mute starts this early so the boundary observer, which fires at or after its time, is never late.
    static let muteLead = 0.05

    enum Resolution {
        case none
        case seek(to: Double, action: String)
        case end(action: String)
    }

    /// Cut and commercial ranges, sorted.
    let skips: [EdlRange]
    /// Position of each skip among the commercials only (nil for a cut); stable across timeline shifts.
    private let ordinals: [Int?]
    var commercialCount: Int { ordinals.compactMap { $0 }.count }
    /// Mute ranges with gaps up to `muteMergeGap` merged.
    let mutes: [(start: Double, end: Double)]

    /// False: commercials are skipped only through `skipCommercial`; cuts stay automatic.
    let autoSkipCommercials: Bool

    init(_ ranges: [EdlRange]?, autoSkipCommercials: Bool = true) {
        self.autoSkipCommercials = autoSkipCommercials
        let valid = (ranges ?? [])
            .filter { $0.start.isFinite && $0.end.isFinite && $0.start >= 0 && $0.end > $0.start }
            .sorted { $0.start < $1.start }
        skips = valid.filter { $0.action == "cut" || $0.action == "commercial" }
        var next = 0
        ordinals = skips.map { r in
            guard r.action == "commercial" else { return nil }
            defer { next += 1 }
            return next
        }
        var merged: [(start: Double, end: Double)] = []
        for r in valid where r.action == "mute" {
            if let last = merged.last, r.start - last.end <= Self.muteMergeGap {
                merged[merged.count - 1].end = max(last.end, r.end)
            } else {
                merged.append((r.start, r.end))
            }
        }
        mutes = merged
    }

    func resolve(_ position: Double, duration: Double, skipped: inout Set<Int>) -> Resolution {
        run(from: position, first: nil, duration: duration, commercials: autoSkipCommercials, skipped: &skipped)
    }

    /// Ordinal of the unskipped commercial whose skippable part (before the tail) holds `t`.
    func commercialOrdinal(at t: Double, skipped: Set<Int>) -> Int? {
        commercialIndex(at: t, skipped: skipped).flatMap { ordinals[$0] }
    }

    /// Skips the commercial at `t` (and whatever follows it) regardless of `autoSkipCommercials`.
    func skipCommercial(at t: Double, duration: Double, skipped: inout Set<Int>) -> Resolution {
        guard let i = commercialIndex(at: t, skipped: skipped) else { return .none }
        skipped.insert(ordinals[i]!)
        return run(from: skips[i].end, first: "commercial", duration: duration, commercials: true, skipped: &skipped)
    }

    /// Where the skip cue appears and disappears (manual mode only).
    var cueEdges: [Double] {
        guard !autoSkipCommercials else { return [] }
        return skips.indices.compactMap { i -> Double? in
            ordinals[i] == nil ? nil : skips[i].end - Self.commercialTail
        }.filter { $0 > 0 }
    }

    private func commercialIndex(at t: Double, skipped: Set<Int>) -> Int? {
        skips.indices.first { i in
            guard let o = ordinals[i] else { return false }
            let r = skips[i]
            return r.start <= t && t < r.end - Self.commercialTail && !skipped.contains(o)
        }
    }

    private func run(
        from position: Double, first: String?, duration: Double, commercials: Bool, skipped: inout Set<Int>
    ) -> Resolution {
        var t = position
        var first = first
        while let i = skips.indices.first(where: { i in
            let r = skips[i]
            return r.start <= t && t < r.end - Self.edgeEps
                && (r.action == "cut" || (commercials && !skipped.contains(ordinals[i]!) && t < r.end - Self.commercialTail))
        }) {
            if let o = ordinals[i] { skipped.insert(o) }
            if first == nil { first = skips[i].action }
            t = skips[i].end
        }
        guard let first else { return .none }
        if duration > 0, t >= duration - Self.eofSlack { return .end(action: first) }
        return .seek(to: t, action: first)
    }

    func isMuted(at t: Double) -> Bool {
        mutes.contains { $0.start - Self.muteLead <= t && t < $0.end }
    }

    /// Every instant where the mute state can change.
    var muteEdges: [Double] { mutes.flatMap { [max(0, $0.start - Self.muteLead), $0.end] } }
}
