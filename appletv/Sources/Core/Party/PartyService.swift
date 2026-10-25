import Foundation

/// Party-wide state: join, leave, the member list, chat and the server's `party.*` events. The player's
/// `PartyController` drives the engine from `live`.
@MainActor
@Observable final class PartyService {
    static let shared = PartyService()

    private(set) var party: Party?
    private(set) var live: PartyLiveState?
    private(set) var members: [PartyMember] = []
    private(set) var messages: [PartyMessage] = []
    private(set) var bubbles: [PartyMessage] = []
    private(set) var queue: [PartyItem] = []
    enum Sheet: String, Identifiable { case invite, settings; var id: String { rawValue } }
    /// Live and scheduled parties of the viewer, for the Home rail.
    private(set) var homeParties: [Party] = []
    /// The invite or settings sheet, shared by the lobby and the player.
    var sheet: Sheet?
    /// A short line for the screen in front (errors, refusals), cleared after a few seconds.
    private(set) var notice: String?

    let clock = PartyClock()
    @ObservationIgnored private let stream = ServerEventStream()
    @ObservationIgnored private var lastRev = 0
    @ObservationIgnored private var refetching: Task<Void, Never>?
    @ObservationIgnored private var refetchAgain = false
    @ObservationIgnored private var noticeTask: Task<Void, Never>?
    @ObservationIgnored private var queuedFor: PartyItem?

    /// File to play, media, episode: pushes the player for the party's current item.
    @ObservationIgnored var onOpenPlayer: ((Int, Int, Int?) -> Void)?
    @ObservationIgnored var onOpenLobby: ((Int) -> Void)?
    @ObservationIgnored var onLive: ((PartyLiveState) -> Void)?
    @ObservationIgnored var onClosed: ((String) -> Void)?
    @ObservationIgnored var onRejoined: (() -> Void)?

    private static let maxMessages = 200
    private static let bubbleSeconds = 4.0

    private init() {
        stream.onEvent = { [weak self] data in
            guard let event = PartyEvent.decode(data) else { return }
            self?.handle(event)
        }
        stream.onConnectionChange = { [weak self] connected in
            guard connected, let self, self.party != nil else { return }
            Task { await self.rejoin() }
        }
    }

    var deviceId: String { DeviceId.current + "#party" }
    var active: Bool { party != nil && live != nil }
    var lobby: Bool { party?.status == "scheduled" && live != nil }
    var me: PartyMember? {
        let uid = AuthService.shared.currentUser?.id
        return members.first { $0.userId == uid && $0.deviceId == deviceId }
    }
    var isHost: Bool { me?.isHost == true }
    var policy: String { party?.policy ?? "everyone" }
    var chatEnabled: Bool { party?.chatEnabled ?? true }
    var canControl: Bool { isHost || policy == "everyone" }
    var item: PartyItem? { live?.item ?? party?.item }

    // MARK: - Entry points

    /// A party for now opens its lobby straight away, so creating is joining.
    func create(name: String, mediaId: Int? = nil, mediaFileId: Int? = nil, episodeId: Int? = nil,
                playlistId: Int? = nil) async {
        struct Body: Encodable {
            let name: String; let mediaId: Int?; let mediaFileId: Int?; let episodeId: Int?; let playlistId: Int?
        }
        do {
            let dto: Party = try await APIClient.shared.post(
                "/api/parties",
                body: Body(name: name, mediaId: mediaId, mediaFileId: mediaFileId, episodeId: episodeId, playlistId: playlistId))
            await enter(id: dto.id)
        } catch {
            show(describe(error))
        }
    }

    /// The player for a live party, the lobby for a scheduled one whose lobby is open.
    func enter(id: Int, token: String? = nil) async {
        struct Body: Encodable { let deviceId: String; let token: String? }
        if let current = party?.id, current != id { await leave() }
        do {
            try await connectStream()
            let dto: Party = try await APIClient.shared.post("/api/parties/\(id)/join", body: Body(deviceId: deviceId, token: token))
            guard dto.live != nil else {
                try? await APIClient.shared.post("/api/parties/\(id)/leave", body: ["deviceId": deviceId])
                stream.stop()
                show(tr("party.toast_not_started"))
                return
            }
            adopt(dto)
            if dto.status == "live" { await openPlayer(dto.item) } else { onOpenLobby?(id) }
        } catch {
            show(describe(error))
            if party == nil { stream.stop() }
        }
    }

    func start() async {
        guard let id = party?.id else { return }
        do {
            let dto: Party = try await APIClient.shared.post("/api/parties/\(id)/start")
            applySnapshot(dto)
            await openPlayer(dto.item)
        } catch {
            show(describe(error))
        }
    }

    func setReady(_ ready: Bool) async {
        guard let id = party?.id else { return }
        try? await sendStatus(id: id, status: ready ? "ready" : "waiting", position: live?.anchor.position ?? 0)
    }

    func leave() async {
        let id = party?.id
        reset()
        if let id { try? await APIClient.shared.post("/api/parties/\(id)/leave", body: ["deviceId": deviceId]) }
        stream.stop()
    }

    // MARK: - Actions

    func sendIntent(_ action: String, position: Double? = nil, item: PartyItem? = nil) async {
        struct Ref: Encodable { let mediaId: Int; let mediaFileId: Int?; let episodeId: Int? }
        struct Body: Encodable { let deviceId: String; let action: String; let position: Double?; let item: Ref?; let baseRev: Int }
        guard let id = party?.id else { return }
        let ref = item.map { Ref(mediaId: $0.mediaId, mediaFileId: $0.mediaFileId, episodeId: $0.episodeId) }
        do {
            try await APIClient.shared.post(
                "/api/parties/\(id)/intent",
                body: Body(deviceId: deviceId, action: action, position: position, item: ref, baseRev: lastRev))
        } catch APIError.badStatus(409, let message) where message == nil || message == "party.error_stale" {
            await refetch()
        } catch {
            show(describe(error))
        }
    }

    /// `ended` carries the item the client saw end, so a second device's or a raced one is a no-op.
    func sendEnded(mediaId: Int, episodeId: Int?) async {
        guard let item = live?.item, item.mediaId == mediaId, item.episodeId == episodeId else { return }
        await sendIntent("ended", item: item)
    }

    func reportStatus(_ status: String, position: Double) async {
        guard let id = party?.id else { return }
        try? await sendStatus(id: id, status: status, position: position)
    }

    private func sendStatus(id: Int, status: String, position: Double) async throws {
        struct Body: Encodable { let deviceId: String; let status: String; let position: Double; let rttMs: Int }
        try await APIClient.shared.post(
            "/api/parties/\(id)/status",
            body: Body(deviceId: deviceId, status: status, position: position, rttMs: clock.rttMs))
    }

    func sendMessage(_ text: String) async {
        struct Body: Encodable { let deviceId: String; let text: String }
        guard let id = party?.id else { return }
        do {
            try await APIClient.shared.post("/api/parties/\(id)/messages", body: Body(deviceId: deviceId, text: text))
        } catch {
            show(describe(error))
        }
    }

    func kick(_ userId: Int) async { await hostAction("members/\(userId)/kick") }
    func makeHost(_ userId: Int) async { await hostAction("members/\(userId)/host") }

    /// Host only. The answer carries the new switches; `party.settings` reaches the other members.
    func updateSettings(policy: String? = nil, reactionsEnabled: Bool? = nil, chatEnabled: Bool? = nil,
                        linkSharing: Bool? = nil) async {
        struct Patch: Encodable {
            let policy: String?; let reactionsEnabled: Bool?; let chatEnabled: Bool?; let linkSharing: Bool?
        }
        await patch(Patch(policy: policy, reactionsEnabled: reactionsEnabled, chatEnabled: chatEnabled, linkSharing: linkSharing))
    }

    /// The old invite link stops working.
    func regenerateLink() async {
        struct Patch: Encodable { let regenerateToken = true }
        await patch(Patch())
    }

    private func patch<B: Encodable>(_ body: B) async {
        guard let id = party?.id else { return }
        do {
            let dto: Party = try await APIClient.shared.patch("/api/parties/\(id)", body: body)
            applySnapshot(dto)
        } catch {
            show(describe(error))
        }
    }

    func invite(_ userIds: [Int]) async {
        struct Body: Encodable { let userIds: [Int] }
        guard let id = party?.id, !userIds.isEmpty else { return }
        do {
            let dto: Party = try await APIClient.shared.post("/api/parties/\(id)/invitees", body: Body(userIds: userIds))
            applySnapshot(dto)
        } catch {
            show(describe(error))
        }
    }

    /// Host only: ends the party for everyone, the `party.closed` event then closes it here too.
    func endParty() async {
        guard let id = party?.id else { return }
        do {
            try await APIClient.shared.delete("/api/parties/\(id)")
        } catch {
            show(describe(error))
        }
    }

    func reload() async { await refetch() }

    func refreshHomeParties() async {
        do {
            homeParties = try await APIClient.shared.get("/api/parties")
        } catch {
            print("party: home rail fetch failed: \(error)")
        }
    }

    private func hostAction(_ path: String) async {
        guard let id = party?.id else { return }
        do {
            try await APIClient.shared.post("/api/parties/\(id)/\(path)")
        } catch {
            show(describe(error))
        }
    }

    // MARK: - Snapshots

    private func connectStream() async throws {
        stream.start(deviceId: deviceId)
        for _ in 0..<100 where !stream.connected {
            try await Task.sleep(for: .milliseconds(100))
        }
        guard stream.connected else { throw APIError.transport("events stream") }
    }

    private func adopt(_ dto: Party) {
        reset()
        applySnapshot(dto)
        clock.start()
    }

    private func reset() {
        clock.stop()
        party = nil
        live = nil
        members = []
        messages = []
        bubbles = []
        queue = []
        sheet = nil
        lastRev = 0
        queuedFor = nil
    }

    func applySnapshot(_ dto: Party) {
        party = dto
        guard let snap = dto.live else { return }
        // A snapshot older than what events already applied would roll the party back.
        guard snap.rev >= lastRev else { return }
        lastRev = snap.rev
        members = snap.members
        if messages.isEmpty { messages = snap.messages }
        setLive(PartyLiveState(rev: snap.rev, state: snap.state, item: dto.item, anchor: snap.anchor, whenMs: nil))
    }

    private func setLive(_ state: PartyLiveState) {
        live = state
        syncQueue(state.item)
        onLive?(state)
    }

    /// One fetch at a time: a call during a fetch asks for one more after it.
    private func refetch() async {
        if let refetching {
            refetchAgain = true
            return await refetching.value
        }
        let run = Task { @MainActor in
            repeat {
                refetchAgain = false
                await refetchOnce()
            } while refetchAgain
        }
        refetching = run
        await run.value
        refetching = nil
    }

    private func refetchOnce() async {
        guard let id = party?.id else { return }
        let wasLobby = lobby
        guard let dto: Party = try? await APIClient.shared.get("/api/parties/\(id)") else { return }
        applySnapshot(dto)
        if wasLobby, dto.status == "live" { await openPlayer(dto.item) }
    }

    /// After a dropped stream the server marked us away: a fresh join rebinds the connection.
    private func rejoin() async {
        struct Body: Encodable { let deviceId: String }
        guard let id = party?.id else { return }
        do {
            let dto: Party = try await APIClient.shared.post("/api/parties/\(id)/join", body: Body(deviceId: deviceId))
            // A restarted server counts revisions and messages from scratch.
            lastRev = 0
            messages = []
            applySnapshot(dto)
            onRejoined?()
        } catch APIError.badStatus(let code, _) where [403, 404, 409].contains(code) {
            closed(reason: code == 403 ? "kicked" : "host_ended")
        } catch {
            // The next reconnect retries.
        }
    }

    private func openPlayer(_ item: PartyItem) async {
        var fileId = item.mediaFileId
        if fileId == nil {
            let media: Media? = try? await APIClient.shared.get("/api/media/\(item.mediaId)")
            fileId = media?.fileId(episodeId: item.episodeId)
        }
        guard let fileId else {
            show(tr("player.next_unavailable"))
            await leave()
            return
        }
        onOpenPlayer?(fileId, item.mediaId, item.episodeId)
    }

    // MARK: - Queue

    private func syncQueue(_ item: PartyItem) {
        if let q = queuedFor, q.mediaId == item.mediaId, q.episodeId == item.episodeId { return }
        if queuedFor != nil, queue.contains(where: { $0.mediaId == item.mediaId && $0.episodeId == item.episodeId }) {
            queuedFor = item
            return
        }
        queuedFor = item
        guard let id = party?.id else { return }
        Task {
            let items: [PartyItem]? = try? await APIClient.shared.get("/api/parties/\(id)/queue")
            if party?.id == id { queue = items ?? [] }
        }
    }

    // MARK: - Events

    func handle(_ event: PartyEvent) {
        switch event {
        case let .starting(partyId, _):
            if partyId == party?.id { Task { await refetch() } }
        case let .updated(partyId):
            if partyId == party?.id, lobby { Task { await refetch() } }
        case .invited:
            break
        case let .state(e):
            guard e.partyId == party?.id else { return }
            // The host's start is not announced to members: the first event after it reveals it.
            if lobby { Task { await refetch() } }
            guard acceptRev(e.rev) else { return }
            setLive(PartyLiveState(rev: e.rev, state: e.state, item: e.item, anchor: e.anchor, whenMs: e.whenMs))
        case let .members(partyId, rev, list):
            guard partyId == party?.id, acceptRev(rev) else { return }
            members = list
        case let .settings(partyId, rev, name, policy, reactions, chat, link):
            guard partyId == party?.id else { return }
            if lobby { Task { await refetch() } }
            guard acceptRev(rev) else { return }
            party?.name = name
            party?.policy = policy
            party?.reactionsEnabled = reactions
            party?.chatEnabled = chat
            party?.linkSharing = link
            if !link, !isHost { party?.inviteToken = nil }
        case let .message(partyId, message):
            guard partyId == party?.id else { return }
            onMessage(message)
        case let .closed(partyId, reason):
            guard partyId == party?.id else { return }
            closed(reason: reason)
        }
    }

    /// Drops a stale event; a gap means we missed one, so the snapshot refetch fills it in.
    private func acceptRev(_ rev: Int) -> Bool {
        guard rev > lastRev else { return false }
        let gap = rev > lastRev + 1
        lastRev = rev
        if gap { Task { await refetch() } }
        return true
    }

    private func onMessage(_ m: PartyMessage) {
        guard !messages.contains(where: { $0.id == m.id }) else { return }
        messages = Array((messages + [m]).suffix(Self.maxMessages))
        guard m.system == nil else { return }
        bubbles = Array((bubbles + [m]).suffix(3))
        Task {
            try? await Task.sleep(for: .seconds(Self.bubbleSeconds))
            bubbles.removeAll { $0.id == m.id }
        }
    }

    private func closed(reason: String) {
        reset()
        stream.stop()
        show(tr("party.closed_\(reason)"))
        onClosed?(reason)
    }

    // MARK: - Notices

    func show(_ text: String) {
        notice = text
        noticeTask?.cancel()
        noticeTask = Task {
            try? await Task.sleep(for: .seconds(4))
            if !Task.isCancelled { notice = nil }
        }
    }

    private func describe(_ error: Error) -> String {
        if case let APIError.badStatus(_, message?) = error {
            let text = tr(message)
            if text != message, !text.contains("{{") { return text }
        }
        return tr("party.error_generic")
    }
}
