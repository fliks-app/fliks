import Foundation

/// Keeps the music player on the party's timeline while a track plays: transport keys become intents,
/// `party.state` drives the player. The audio counterpart of `PartyController`.
@MainActor
final class MusicPartyDriver {
    static let shared = MusicPartyDriver()

    private let party = PartyService.shared
    private let player = MusicPlayer.shared
    private var generation = 0
    private var attached = false
    private var driftTimer: Timer?
    private var playTask: Task<Void, Never>?
    private var lastCorrectiveSeek = Date.distantPast
    private var cache: [Int: AlbumPage] = [:]
    private static let readyTimeoutS = 30.0
    private static let seekSlackS = 0.5

    func attach() {
        guard !attached else { return resync() }
        attached = true
        player.intercept = { [weak self] t in self?.intercept(t) ?? false }
        player.onTrackEnded = { [weak self] _ in self?.ended() }
        party.onLive = { [weak self] live in self?.apply(live) }
        party.onRejoined = { [weak self] in self?.resync() }
        driftTimer = Timer.scheduledTimer(withTimeInterval: PartySync.driftCheckS, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.checkDrift() }
        }
        resync()
    }

    func detach() {
        guard attached else { return }
        attached = false
        generation += 1
        playTask?.cancel()
        driftTimer?.invalidate()
        driftTimer = nil
        player.intercept = nil
        player.onTrackEnded = nil
        party.onLive = nil
        party.onRejoined = nil
        player.stop()
        if party.active { Task { await party.leave() } }
    }

    private func resync() {
        if let live = party.live { apply(live) }
    }

    // MARK: - Transport -> intents

    private func intercept(_ t: MusicTransport) -> Bool {
        guard party.active else { return false }
        guard party.canControl else {
            party.show(tr("party.error_host_only"))
            return true
        }
        Task {
            switch t {
            case .play: await party.sendIntent("play")
            case .pause: await party.sendIntent("pause")
            case .seek(let p): await party.sendIntent("seek", position: p)
            case .next: await party.sendIntent("next")
            case .previous: await party.sendIntent("previous")
            }
        }
        return true
    }

    /// The host's natural end: the server idles the party and moves it along its queue.
    private func ended() {
        guard party.active, party.isHost, let item = party.live?.item, item.isTrack else { return }
        Task { await party.sendEnded(mediaId: item.mediaId, episodeId: item.episodeId, itemId: item.itemId) }
    }

    // MARK: - Party state -> player

    private func apply(_ live: PartyLiveState) {
        guard attached else { return }
        guard live.item.isTrack else { return leaveForVideo(live.item) }
        generation += 1
        let gen = generation
        playTask?.cancel()
        Task { @MainActor in
            if player.current?.itemId != live.item.itemId {
                guard let track = await track(for: live.item), gen == generation else {
                    if gen == generation { party.show(tr("player.next_unavailable")) }
                    return
                }
                player.open(track, autoplay: false)
            }
            guard await untilReady(gen) else { return }
            if live.state == "playing" { await applyPlaying(live, gen) } else { await applyHeld(live, gen) }
        }
    }

    /// A video follows a track: the party hands over to the video player.
    private func leaveForVideo(_ item: PartyItem) {
        attached = false
        driftTimer?.invalidate()
        driftTimer = nil
        player.intercept = nil
        player.onTrackEnded = nil
        player.stop()
        Task { await party.reopenPlayer(item) }
    }

    private func applyHeld(_ live: PartyLiveState, _ gen: Int) async {
        player.apply(.pause)
        guard await seekIfFar(live.anchor.position, gen) else { return }
        await party.reportStatus("ready", position: live.anchor.position)
    }

    private func applyPlaying(_ live: PartyLiveState, _ gen: Int) async {
        let startAt = live.whenMs ?? live.anchor.serverTimeMs
        let wait = startAt - party.clock.serverNowMs()
        if wait > 0 {
            player.apply(.pause)
            guard await seekIfFar(live.anchor.position, gen) else { return }
            await party.reportStatus("ready", position: live.anchor.position)
            playTask = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(max(0, startAt - (self?.party.clock.serverNowMs() ?? startAt))))
                guard !Task.isCancelled, let self, gen == self.generation else { return }
                self.player.apply(.play)
            }
            return
        }
        let target = PartySync.groupPosition(state: "playing", anchor: live.anchor, serverNowMs: party.clock.serverNowMs())
        guard await seekIfFar(target, gen) else { return }
        player.apply(.play)
        await party.reportStatus("ready", position: target)
    }

    private func seekIfFar(_ target: Double, _ gen: Int) async -> Bool {
        if abs(player.position - target) > Self.seekSlackS {
            player.apply(.seek(target))
            lastCorrectiveSeek = Date()
        }
        return gen == generation
    }

    private func untilReady(_ gen: Int) async -> Bool {
        let deadline = Date().addingTimeInterval(Self.readyTimeoutS)
        while gen == generation, Date() < deadline {
            if player.itemReady { return true }
            try? await Task.sleep(for: .milliseconds(100))
        }
        return false
    }

    private func checkDrift() {
        guard let live = party.live, live.state == "playing", player.itemReady, player.isPlaying, !player.isBuffering else { return }
        let now = party.clock.serverNowMs()
        guard now >= (live.whenMs ?? live.anchor.serverTimeMs) else { return }
        let target = PartySync.groupPosition(state: "playing", anchor: live.anchor, serverNowMs: now)
        switch PartySync.driftAction(drift: player.livePosition() - target,
                                     msSinceSeek: Date().timeIntervalSince(lastCorrectiveSeek) * 1000) {
        case .seek:
            lastCorrectiveSeek = Date()
            player.apply(.seek(target))
        case .rate(let rate):
            if player.currentRate != rate { player.setRate(rate) }
        case .none:
            if player.currentRate != 1 { player.setRate(1) }
        }
    }

    // MARK: - Tracks

    /// The queue entry of a party track: the album page names its gain and artists.
    private func track(for item: PartyItem) async -> QueueTrack? {
        let page: AlbumPage
        if let hit = cache[item.mediaId] { page = hit } else {
            guard let fetched = try? await MusicAPI.albumPage(item.mediaId) else { return nil }
            cache[item.mediaId] = fetched
            page = fetched
        }
        guard let t = page.album.tracks.first(where: { $0.itemId == item.itemId }) else { return nil }
        return QueueTrack(track: t, album: page, edition: page.album.editions.first { $0.id == t.editionId })
    }
}
