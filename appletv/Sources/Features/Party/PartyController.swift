import Foundation
import UIKit

/// Keeps the local player on the party's timeline: transport changes become intents, `party.state`
/// drives the player directly. Mirrors the web `party-controller.ts`.
@MainActor
final class PartyController {
    private let party = PartyService.shared
    private unowned let player: PlayerCoordinator

    private var generation = 0
    private var playTask: Task<Void, Never>?
    private var driftTimer: Timer?
    private var transportTask: Task<Void, Never>?
    private var applying = false
    private var lastCorrectiveSeek = Date.distantPast
    private var lastOwnSeek: (at: Date, position: Double)?
    private var pendingJump: Double?
    private var lastReported = "ready"
    private var menuKey = ""
    private var itemEnded = false
    private var primed = false
    private var watcher = PartySync.TransportWatcher()
    private var pendingChange: PartySync.TransportChange?
    /// A scheduled start is waiting for its time: the player is paused by us, not by the viewer.
    private var scheduledStart = false
    private var ownUntil = Date.distantPast

    /// Close enough to the anchor that a seek would only restart a transcode for nothing.
    private static let seekSlackS = 0.25
    private static let readyTimeoutS = 60.0
    /// A pause or seek of the viewer settles this long before it is sent, so a scrub is one seek.
    private static let transportSettle = Duration.milliseconds(450)
    /// How long after our own play, pause or seek the player's notifications are still ours.
    private static let ownWindowS = 1.0

    init(player: PlayerCoordinator) {
        self.player = player
    }

    func attach() {
        player.partyDriven = true
        player.onTimeControlChange = { [weak self] in self?.transportChanged() }
        player.onTimeJump = { [weak self] position in self?.jumped(to: position) }
        player.onItemEnded = { [weak self] in self?.ended() }
        party.onLive = { [weak self] live in self?.apply(live, force: false) }
        party.onRejoined = { [weak self] in self?.resync() }
        driftTimer = Timer.scheduledTimer(withTimeInterval: PartySync.driftCheckS, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.checkDrift() }
        }
        resync()
        refreshMenu()
    }

    func detach() {
        generation += 1
        playTask?.cancel()
        transportTask?.cancel()
        driftTimer?.invalidate()
        driftTimer = nil
        player.partyDriven = false
        player.onTimeControlChange = nil
        player.onTimeJump = nil
        player.onItemEnded = nil
        player.partyMenus = []
        party.onLive = nil
        party.onRejoined = nil
        // Closing the player is leaving the party.
        if party.active { Task { await party.leave() } }
    }

    /// Forced seek to wherever the group is.
    func resync() {
        if let live = party.live { apply(live, force: true) }
    }

    // MARK: - Party state -> player

    private func apply(_ live: PartyLiveState, force: Bool) {
        generation += 1
        let gen = generation
        playTask?.cancel()
        scheduledStart = false
        applying = true
        if live.state == "playing" { itemEnded = false }
        Task { @MainActor in
            defer { if gen == generation { applying = false } }
            guard await untilReady(gen) else { return }
            if itemDiffers(live.item) {
                itemEnded = false
                primed = false
                guard await open(live.item, gen) else { return }
                guard await untilReady(gen) else { return }
            }
            guard player.itemReady, gen == generation else { return }
            if live.state == "playing" { await applyPlaying(live, gen, force) } else { await applyHeld(live, gen, force) }
        }
    }

    private func itemDiffers(_ item: PartyItem) -> Bool {
        let cur = player.currentItemIds
        return item.mediaId != cur.mediaId || item.episodeId != cur.episodeId
    }

    private func open(_ item: PartyItem, _ gen: Int) async -> Bool {
        if let fileId = await party.fileId(for: item), await player.openItem(mediaFileId: fileId, mediaId: item.mediaId, episodeId: item.episodeId, play: false) {
            return gen == generation
        }
        // This device cannot open it: the group must not wait on us.
        if gen == generation {
            party.show(tr("player.next_unavailable"))
            player.onStopRequested?()
        }
        return false
    }

    /// idle, paused and waiting all hold the player paused at the anchor; waiting then reports ready once the seek landed.
    private func applyHeld(_ live: PartyLiveState, _ gen: Int, _ force: Bool) async {
        ownPause()
        guard await seekIfFar(live.anchor.position, gen, force) else { return }
        if !primed {
            primed = true
            await player.preroll()
            guard gen == generation else { return }
        }
        reportReady(live.anchor.position)
    }

    private func applyPlaying(_ live: PartyLiveState, _ gen: Int, _ force: Bool) async {
        let startAt = live.whenMs ?? live.anchor.serverTimeMs
        let wait = startAt - party.clock.serverNowMs()
        if wait > 0 {
            ownPause()
            guard await seekIfFar(live.anchor.position, gen, force) else { return }
            reportReady(live.anchor.position)
            let remaining = startAt - party.clock.serverNowMs()
            scheduledStart = true
            playTask = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(max(0, remaining)))
                guard !Task.isCancelled, let self, gen == self.generation else { return }
                self.ownPlay()
                self.scheduledStart = false
            }
            return
        }
        // Late, or joining mid-play: land on the extrapolated position, then play.
        let target = PartySync.groupPosition(state: "playing", anchor: live.anchor, serverNowMs: party.clock.serverNowMs())
        guard await seekIfFar(target, gen, force || !player.isPlaying) else { return }
        ownPlay()
        reportReady(player.currentPosition)
    }

    /// False when a newer apply superseded this one while waiting.
    private func seekIfFar(_ target: Double, _ gen: Int, _ force: Bool) async -> Bool {
        if force || abs(player.currentPosition - target) > Self.seekSlackS {
            await ownSeek(to: target)
            lastCorrectiveSeek = Date()
        }
        return gen == generation
    }

    private func ownSeek(to position: Double) async {
        lastOwnSeek = (Date(), position)
        await player.partySeek(to: position)
        lastOwnSeek = (Date(), position)
        ownUntil = Date().addingTimeInterval(Self.ownWindowS)
    }

    private func ownPlay() {
        ownUntil = Date().addingTimeInterval(Self.ownWindowS)
        player.partyPlay()
    }

    private func ownPause() {
        ownUntil = Date().addingTimeInterval(Self.ownWindowS)
        player.partyPause()
    }

    /// Anything the controller is doing itself, whose play/pause echoes must not be read as the viewer.
    private var ownAction: Bool { applying || scheduledStart || Date() < ownUntil }

    private func reportReady(_ position: Double) {
        lastReported = "ready"
        Task { await party.reportStatus("ready", position: position) }
    }

    private func untilReady(_ gen: Int) async -> Bool {
        let deadline = Date().addingTimeInterval(Self.readyTimeoutS)
        while gen == generation, Date() < deadline {
            if player.itemReady { return true }
            try? await Task.sleep(for: .milliseconds(100))
        }
        return false
    }

    // MARK: - Local transport -> intents

    private func transportChanged() {
        if party.active, !applying { reportBuffering() }
        guard let change = watcher.observe(playing: !player.userPaused, own: ownAction), party.active else { return }
        pendingChange = change
        scheduleSettle()
    }

    private func jumped(to position: Double) {
        guard party.active, !applying else { return }
        if let own = lastOwnSeek, Date().timeIntervalSince(own.at) < 5, abs(own.position - position) < 1.5 { return }
        pendingJump = position
        scheduleSettle()
    }

    private func scheduleSettle() {
        transportTask?.cancel()
        transportTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: Self.transportSettle)
            guard !Task.isCancelled else { return }
            await self?.settle()
        }
    }

    /// Sends what the viewer did once it stopped changing; a refused action puts the player back.
    private func settle() async {
        guard party.active, !applying, let live = party.live else { return }
        if let position = pendingJump {
            pendingJump = nil
            guard party.canControl else { return denied(live) }
            await party.sendIntent("seek", position: position)
            return
        }
        guard let change = pendingChange else { return }
        pendingChange = nil
        // The viewer may have undone it inside the settle window.
        guard (change == .paused) == player.userPaused else { return }
        if live.state == "waiting" || itemEnded { return resyncIfPlaying(live) }
        let startReached = (live.whenMs ?? live.anchor.serverTimeMs) <= party.clock.serverNowMs()
        guard let intent = PartySync.intent(for: change, partyState: live.state, startReached: startReached) else { return }
        guard party.canControl else { return denied(live) }
        await party.sendIntent(intent)
    }

    private func resyncIfPlaying(_ live: PartyLiveState) {
        if player.isPlaying { ownPause() }
    }

    private func denied(_ live: PartyLiveState) {
        party.show(tr("party.error_host_only"))
        apply(live, force: true)
    }

    /// The host's natural end: the server idles the party and moves it along its queue.
    private func ended() {
        itemEnded = true
        guard party.active, party.isHost else { return }
        let ids = player.currentItemIds
        Task { await party.sendEnded(mediaId: ids.mediaId, episodeId: ids.episodeId) }
    }

    private func reportBuffering() {
        guard party.live?.state == "playing" else { return }
        let status = player.isBuffering ? "buffering" : "ready"
        guard status != lastReported else { return }
        lastReported = status
        Task { await party.reportStatus(status, position: player.currentPosition) }
    }

    // MARK: - Drift

    private func checkDrift() {
        refreshMenu()
        guard let live = party.live, live.state == "playing", player.itemReady, !applying else { return }
        let now = party.clock.serverNowMs()
        guard player.isPlaying, !player.isBuffering, now >= (live.whenMs ?? live.anchor.serverTimeMs) else { return }
        let target = PartySync.groupPosition(state: "playing", anchor: live.anchor, serverNowMs: now)
        let action = PartySync.driftAction(
            drift: player.currentPosition - target,
            msSinceSeek: Date().timeIntervalSince(lastCorrectiveSeek) * 1000)
        switch action {
        case .seek:
            lastCorrectiveSeek = Date()
            Task { await ownSeek(to: target) }
        case .rate(let rate):
            if player.currentRate != rate { player.partySetRate(rate) }
        case .none:
            if player.currentRate != 1 { player.partySetRate(1) }
        }
    }

    // MARK: - Menu

    /// Rebuilt only when what it shows changes: reassigning it closes the menu under the viewer.
    private func refreshMenu() {
        let key = PartyMenu.key(party)
        guard key != menuKey else { return }
        menuKey = key
        player.partyMenus = [PartyMenu.build(party, onResync: { [weak self] in self?.resync() },
                                              onLeave: { [weak party = self.party] in Task { await party?.leaveToHome() } })]
    }
}
