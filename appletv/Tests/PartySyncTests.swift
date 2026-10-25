import XCTest
@testable import FliksTV

final class PartySyncTests: XCTestCase {
    private let anchor = PartyAnchor(position: 100, serverTimeMs: 5000)

    func testGroupPositionExtrapolatesWhilePlaying() {
        XCTAssertEqual(PartySync.groupPosition(state: "playing", anchor: anchor, serverNowMs: 8000), 103)
    }

    func testGroupPositionHoldsTheAnchorBeforeAScheduledStart() {
        XCTAssertEqual(PartySync.groupPosition(state: "playing", anchor: anchor, serverNowMs: 4000), 100)
    }

    func testGroupPositionHoldsTheAnchorWhenNotPlaying() {
        XCTAssertEqual(PartySync.groupPosition(state: "paused", anchor: anchor, serverNowMs: 99_000), 100)
        XCTAssertEqual(PartySync.groupPosition(state: "waiting", anchor: anchor, serverNowMs: 99_000), 100)
    }

    func testDriftUnderHalfASecondIsIgnored() {
        XCTAssertEqual(PartySync.driftAction(drift: 0.4, msSinceSeek: 60_000), .none)
        XCTAssertEqual(PartySync.driftAction(drift: -0.49, msSinceSeek: 60_000), .none)
    }

    func testSmallDriftNudgesTheRateTowardTheGroup() {
        XCTAssertEqual(PartySync.driftAction(drift: 1, msSinceSeek: 60_000), .rate(0.95))
        XCTAssertEqual(PartySync.driftAction(drift: -2, msSinceSeek: 60_000), .rate(1.05))
    }

    func testLargeDriftSeeks() {
        XCTAssertEqual(PartySync.driftAction(drift: 4, msSinceSeek: 60_000), .seek)
        XCTAssertEqual(PartySync.driftAction(drift: -3, msSinceSeek: 60_000), .seek)
    }

    func testCorrectiveSeeksAreRateLimitedAndNeverWhileLocked() {
        XCTAssertEqual(PartySync.driftAction(drift: 5, msSinceSeek: 9000), .none)
        XCTAssertEqual(PartySync.driftAction(drift: 5, msSinceSeek: 10_000), .seek)
        XCTAssertEqual(PartySync.driftAction(drift: 5, msSinceSeek: 60_000, seekLocked: true), .none)
    }

    func testNtpSampleOffsetAndDelay() {
        // Server clock 1000 ms ahead, 40 ms each way, 2 ms of server processing.
        let sample = PartySync.ntpSample(t0: 10_000, t1: 11_040, t2: 11_042, t3: 10_082)
        XCTAssertEqual(sample.offset, 1000)
        XCTAssertEqual(sample.delay, 80)
    }

    func testBestSampleIsTheSmallestRoundTrip() {
        let samples = [PartySync.ClockSample(offset: 5, delay: 90), .init(offset: 7, delay: 20), .init(offset: 9, delay: 50)]
        XCTAssertEqual(PartySync.bestSample(samples)?.offset, 7)
        XCTAssertNil(PartySync.bestSample([]))
    }
}
