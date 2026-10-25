import Foundation

/// Server clock estimate, kept fresh only while a party needs it.
@MainActor
final class PartyClock {
    private struct Times: Decodable { let t1: Double; let t2: Double }

    private var samples: [PartySync.ClockSample] = []
    private var task: Task<Void, Never>?

    private(set) var offsetMs = 0.0
    private(set) var rttMs = 0

    func serverNowMs() -> Double { Date().timeIntervalSince1970 * 1000 + offsetMs }

    func start() {
        guard task == nil else { return }
        samples = []
        task = Task { [weak self] in
            var n = 0
            while !Task.isCancelled {
                await self?.ping()
                n += 1
                try? await Task.sleep(for: .seconds(n < 3 ? 1 : 60))
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
    }

    private func ping() async {
        let t0 = Date().timeIntervalSince1970 * 1000
        guard let times: Times = try? await APIClient.shared.get("/api/time") else { return }
        let t3 = Date().timeIntervalSince1970 * 1000
        samples = Array((samples + [PartySync.ntpSample(t0: t0, t1: times.t1, t2: times.t2, t3: t3)]).suffix(8))
        guard let best = PartySync.bestSample(samples) else { return }
        offsetMs = best.offset
        rttMs = max(0, Int(best.delay.rounded()))
    }
}
