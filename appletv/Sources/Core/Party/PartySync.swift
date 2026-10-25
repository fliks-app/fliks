import Foundation

/// Drift correction and clock maths of a watch party, kept pure so they are unit-tested. Mirrors the
/// web `party-sync.ts`.
enum PartySync {
    /// Drift under this is inaudible and left alone.
    static let driftIgnoreS = 0.5
    /// Beyond this a rate nudge takes too long to converge: seek.
    static let driftSeekS = 3.0
    static let driftCheckS = 2.0
    static let seekCooldownS = 10.0
    static let nudgeSlow: Float = 0.95
    static let nudgeFast: Float = 1.05

    /// Where the group is at `serverNow`; before the anchor of a playing party it is still at the anchor.
    static func groupPosition(state: String, anchor: PartyAnchor, serverNowMs: Double) -> Double {
        guard state == "playing" else { return anchor.position }
        return anchor.position + max(0, serverNowMs - anchor.serverTimeMs) / 1000
    }

    enum DriftAction: Equatable {
        case none
        case rate(Float)
        case seek
    }

    /// `drift` is local minus group, in seconds: positive means we are ahead.
    static func driftAction(drift: Double, msSinceSeek: Double, seekLocked: Bool = false) -> DriftAction {
        let size = abs(drift)
        if size < driftIgnoreS { return .none }
        if size < driftSeekS { return .rate(drift > 0 ? nudgeSlow : nudgeFast) }
        if seekLocked || msSinceSeek < seekCooldownS * 1000 { return .none }
        return .seek
    }

    /// What the viewer did on the transport, as opposed to what the controller or AVFoundation did.
    enum TransportChange: Equatable { case paused, played }

    /// Turns observed play/pause states into viewer changes: a change counts only when nothing of ours
    /// (an apply, a scheduled start, our own play, pause or seek) was going on.
    struct TransportWatcher {
        private var last: Bool?

        mutating func observe(playing: Bool, own: Bool) -> TransportChange? {
            defer { last = playing }
            guard !own, let last, last != playing else { return nil }
            return playing ? .played : .paused
        }
    }

    /// The intent a viewer change warrants, nil when the party is already where the viewer put it.
    static func intent(for change: TransportChange, partyState: String, startReached: Bool) -> String? {
        switch change {
        case .paused: return partyState == "playing" && startReached ? "pause" : nil
        case .played: return partyState == "paused" || partyState == "idle" ? "play" : nil
        }
    }

    struct ClockSample: Equatable {
        let offset: Double
        let delay: Double
    }

    /// NTP exchange: t0/t3 are local send/receive, t1/t2 the server's reception/reply.
    static func ntpSample(t0: Double, t1: Double, t2: Double, t3: Double) -> ClockSample {
        ClockSample(offset: (t1 - t0 + (t2 - t3)) / 2, delay: t3 - t0 - (t2 - t1))
    }

    /// The sample with the smallest round trip: the least asymmetric one.
    static func bestSample(_ samples: [ClockSample]) -> ClockSample? {
        samples.min { $0.delay < $1.delay }
    }
}
