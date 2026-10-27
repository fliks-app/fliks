import Foundation

/// Party-wide state: join, leave, the member list, chat and the server's `party.*` events. The player's
/// `PartyController` drives the engine from `live`.
@MainActor
@Observable final class PartyService {
    static let shared = PartyService()

    private(set) var party: Party?
    /// What plays: nil in the lobby, before the host starts.
    private(set) var live: PartyLiveState?
    /// In the party's room, whether or not a film plays yet.
    private(set) var joined = false
    private(set) var members: [PartyMember] = []
    private(set) var messages: [PartyMessage] = []
    private(set) var bubbles: [PartyMessage] = []
    private(set) var queue: [PartyItem] = []
    /// What the guests suggested for the start (lobby only).
    private(set) var proposals: [PartyProposal] = []
    private(set) var reactions: [FloatingReaction] = []
    private(set) var reactionBar = PartyReactions.fallbackBar
    enum Sheet: String, Identifiable { case invite, settings, chat, propose, create, programme; var id: String { rawValue } }
    /// What the create sheet opens with: the film or playlist it was launched from, or nothing from the Home.
    private(set) var createTarget = PartyCreateTarget()
    /// Live and scheduled parties of the viewer, for the Home rail.
    private(set) var homeParties: [Party] = []
    /// The invite or settings sheet, shared by the lobby and the player.
    var sheet: Sheet?
    /// The host asked to leave from the player menu: confirm before ending the party for everyone.
    var leaveConfirm = false
    /// The party the detail page shows while not joined, so the invite and settings pages can act on it.
    private(set) var preview: Party?
    /// A short line for the screen in front (errors, refusals), cleared after a few seconds.
    private(set) var notice: String?

    let clock = PartyClock()
    @ObservationIgnored private let stream = ServerEventStream()
    @ObservationIgnored private var lastRev = 0
    @ObservationIgnored private var refetching: Task<Void, Never>?
    @ObservationIgnored private var refetchAgain = false
    @ObservationIgnored private var noticeTask: Task<Void, Never>?
    @ObservationIgnored private var queuedFor: PartyItem?
    @ObservationIgnored private var handoff = false
    @ObservationIgnored private var nextReactionId = 0
    /// Proposals carry no revision: a snapshot fetched before a `party.proposals` event must not overwrite it.
    @ObservationIgnored private var proposalEvents = 0

    /// File to play, media, episode: pushes the player for the party's current item.
    @ObservationIgnored var onOpenPlayer: ((Int, Int, Int?) -> Void)?
    @ObservationIgnored var onOpenLobby: ((Int) -> Void)?
    @ObservationIgnored var onLive: ((PartyLiveState) -> Void)?
    @ObservationIgnored var onClosed: ((String) -> Void)?
    /// Pops the whole navigation stack back to the Home.
    @ObservationIgnored var onGoHome: (() -> Void)?
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
    var active: Bool { party != nil && joined }
    var lobby: Bool { party?.status == "scheduled" && joined }
    var me: PartyMember? {
        let uid = AuthService.shared.currentUser?.id
        return members.first { $0.userId == uid && $0.deviceId == deviceId }
    }
    var isHost: Bool { me?.isHost == true }
    var policy: String { party?.policy ?? "everyone" }
    var chatEnabled: Bool { party?.chatEnabled ?? true }
    var reactionsEnabled: Bool { party?.reactionsEnabled ?? true }
    var canControl: Bool { isHost || policy == "everyone" }
    /// The joined party, else the one on the detail page.
    var managed: Party? { party ?? preview }
    var managedIsHost: Bool {
        party != nil ? isHost : preview?.host.userId == AuthService.shared.currentUser?.id
    }
    var managedMembers: [PartyMember] { party != nil ? members : preview?.live?.members ?? [] }

    func setPreview(_ dto: Party?) { preview = dto }

    var item: PartyItem? { live?.item ?? party?.item }
    /// The programme has a head, or a suggestion the start can take (a masked one cannot be played).
    var canStart: Bool { party?.item != nil || proposals.contains { !$0.item.hidden } }

    // MARK: - Entry points

    func openCreate(_ target: PartyCreateTarget = PartyCreateTarget()) {
        createTarget = target
        sheet = .create
    }

    /// A party for now opens its lobby straight away, so creating is joining; a scheduled one lands in the Home rail.
    func create(_ request: PartyCreateRequest) async {
        do {
            let dto: Party = try await APIClient.shared.post("/api/parties", body: request)
            sheet = nil
            if request.scheduledAt == nil { await enter(id: dto.id) } else { await refreshHomeParties() }
        } catch {
            show(describe(error))
        }
    }

    /// Host only, while scheduled.
    func reschedule(_ date: Date) async {
        struct Patch: Encodable { let scheduledAt: String }
        await patch(Patch(scheduledAt: PartyCreateRequest.iso(date)))
    }

    /// Host only: the whole programme in its new order (reorder, remove and add are one list).
    func setProgramme(_ items: [PartyItem]) async -> Bool {
        struct Row: Encodable { let mediaId: Int; let mediaFileId: Int?; let episodeId: Int? }
        struct Body: Encodable { let items: [Row] }
        guard let id = managed?.id else { return false }
        do {
            let dto: Party = try await APIClient.shared.put(
                "/api/parties/\(id)/programme",
                body: Body(items: items.map { Row(mediaId: $0.mediaId, mediaFileId: $0.mediaFileId, episodeId: $0.episodeId) }))
            applyManaged(dto)
            return true
        } catch {
            show(describe(error))
            return false
        }
    }

    /// The programme in its order, for a party that is not joined.
    func fetchQueue() async -> [PartyItem] {
        guard let id = managed?.id else { return [] }
        return (try? await APIClient.shared.get("/api/parties/\(id)/queue")) ?? []
    }

    func removeProposal(_ proposalId: Int) async {
        guard let id = party?.id else { return }
        do { try await APIClient.shared.delete("/api/parties/\(id)/proposals/\(proposalId)") } catch { show(describe(error)) }
    }

    /// The player for a live party, the lobby for a scheduled one: its room is open from creation.
    func enter(id: Int, token: String? = nil) async {
        struct Body: Encodable { let deviceId: String; let token: String? }
        if let current = party?.id, current != id { await leave() }
        do {
            try await connectStream()
            let dto: Party = try await APIClient.shared.post("/api/parties/\(id)/join", body: Body(deviceId: deviceId, token: token))
            adopt(dto)
            if dto.status == "live", let item = dto.item { await openPlayer(item) } else { onOpenLobby?(id) }
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
            if let item = dto.item { await openPlayer(item) }
        } catch {
            show(describe(error))
        }
    }

    func setReady(_ ready: Bool) async {
        guard let id = party?.id else { return }
        try? await sendStatus(id: id, status: ready ? "ready" : "waiting", position: live?.anchor.position ?? 0)
    }

    /// An explicit leave: the viewer lands on the Home, unlike an exit from the player.
    func leaveToHome() async {
        await leave()
        onGoHome?()
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

    /// `value` nil clears the caller's vote.
    func vote(_ proposalId: Int, _ value: Int?) async {
        struct Body: Encodable { let value: Int }
        guard let id = party?.id else { return }
        do {
            if let value {
                try await APIClient.shared.put("/api/parties/\(id)/proposals/\(proposalId)/vote", body: Body(value: value))
            } else {
                try await APIClient.shared.delete("/api/parties/\(id)/proposals/\(proposalId)/vote")
            }
        } catch {
            show(describe(error))
        }
    }

    func propose(mediaId: Int, episodeId: Int?) async -> Bool {
        struct Body: Encodable { let mediaId: Int; let episodeId: Int? }
        guard let id = party?.id else { return false }
        do {
            try await APIClient.shared.post("/api/parties/\(id)/proposals", body: Body(mediaId: mediaId, episodeId: episodeId))
            return true
        } catch {
            show(describe(error))
            return false
        }
    }

    func choose(_ proposalId: Int) async { await hostAction("proposals/\(proposalId)/choose") }

    func sendMessage(_ text: String) async {
        struct Body: Encodable { let deviceId: String; let text: String }
        guard let id = party?.id else { return }
        do {
            try await APIClient.shared.post("/api/parties/\(id)/messages", body: Body(deviceId: deviceId, text: text))
        } catch {
            show(describe(error))
        }
    }

    func react(_ emoji: String) async {
        struct Body: Encodable { let deviceId: String; let emoji: String }
        guard let id = party?.id, reactionsEnabled else { return }
        do {
            try await APIClient.shared.post("/api/parties/\(id)/reactions", body: Body(deviceId: deviceId, emoji: emoji))
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
        guard let id = managed?.id else { return }
        do {
            let dto: Party = try await APIClient.shared.patch("/api/parties/\(id)", body: body)
            applyManaged(dto)
        } catch {
            show(describe(error))
        }
    }

    func invite(_ userIds: [Int]) async {
        struct Body: Encodable { let userIds: [Int] }
        guard let id = managed?.id, !userIds.isEmpty else { return }
        do {
            let dto: Party = try await APIClient.shared.post("/api/parties/\(id)/invitees", body: Body(userIds: userIds))
            applyManaged(dto)
        } catch {
            show(describe(error))
        }
    }

    /// Host only: ends the party for everyone, the `party.closed` event then closes it here too.
    func endParty() async {
        guard let id = managed?.id else { return }
        do {
            try await APIClient.shared.delete("/api/parties/\(id)")
            // Not joined: no `party.closed` will come, the detail page follows its own refresh.
            if party == nil { preview = nil; sheet = nil; onGoHome?() }
        } catch {
            show(describe(error))
        }
    }

    /// The viewer leaves the party for good and returns to the Home; a 404 means they already had.
    func quit(id: Int) async {
        do {
            try await APIClient.shared.post("/api/parties/\(id)/quit")
        } catch APIError.badStatus(404, _) {
        } catch {
            return show(describe(error))
        }
        preview = nil
        sheet = nil
        onGoHome?()
    }

    func reload() async {
        if party != nil { return await refetch() }
        if let id = preview?.id, let dto: Party = try? await APIClient.shared.get("/api/parties/\(id)") { preview = dto }
    }

    private func applyManaged(_ dto: Party) {
        if party?.id == dto.id { applySnapshot(dto) } else { preview = dto }
    }

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
        Task {
            struct Catalog: Decodable { let defaults: [String] }
            if let catalog: Catalog = try? await APIClient.shared.get("/api/parties/reactions"), !catalog.defaults.isEmpty {
                reactionBar = catalog.defaults
            }
        }
    }

    private func reset() {
        clock.stop()
        party = nil
        live = nil
        members = []
        messages = []
        bubbles = []
        reactions = []
        queue = []
        proposals = []
        sheet = nil
        leaveConfirm = false
        lastRev = 0
        queuedFor = nil
        joined = false
    }

    /// `proposals: false` keeps the ones held, for a snapshot that predates a `party.proposals` event.
    func applySnapshot(_ dto: Party, proposals fresh: Bool = true) {
        party = dto
        if fresh, let list = dto.proposals { proposals = list }
        if dto.status == "scheduled" { Task { await loadQueue(dto.id) } }
        guard let snap = dto.live else { return }
        // A snapshot older than what events already applied would roll the party back.
        guard snap.rev >= lastRev else { return }
        lastRev = snap.rev
        joined = true
        members = snap.members
        if messages.isEmpty { messages = snap.messages }
        guard let playback = snap.playback, let item = dto.item else { live = nil; return }
        setLive(PartyLiveState(rev: snap.rev, state: playback.state, item: item, anchor: playback.anchor, whenMs: nil))
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
        let seen = proposalEvents
        guard let dto: Party = try? await APIClient.shared.get("/api/parties/\(id)") else { return }
        applySnapshot(dto, proposals: seen == proposalEvents)
        if wasLobby, dto.status == "live", let item = dto.item { await openPlayer(item) }
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
        } catch APIError.badStatus(let code, let message) where [403, 404, 409].contains(code) && message != "party.error_no_connection" {
            closed(reason: code == 403 ? "kicked" : "host_ended")
        } catch {
            // A restarting server may not register the stream yet: retry while it stays up.
            try? await Task.sleep(for: .seconds(2))
            if party?.id == id, stream.connected { await rejoin() }
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
        handoff = true
        onOpenPlayer?(fileId, item.mediaId, item.episodeId)
    }

    /// True once for the player the party just opened; any other playback is a plain one, whatever the party state.
    func takeHandoff() -> Bool {
        defer { handoff = false }
        return handoff && active
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
        Task { await loadQueue(id) }
    }

    private func loadQueue(_ id: Int) async {
        let items: [PartyItem]? = try? await APIClient.shared.get("/api/parties/\(id)/queue")
        if party?.id == id { queue = items ?? [] }
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
        case let .programme(partyId, rev, item):
            guard partyId == party?.id, acceptRev(rev) else { return }
            if lobby { party?.item = item }
            Task { await loadQueue(partyId) }
        case let .proposals(partyId, list):
            guard partyId == party?.id else { return }
            proposalEvents += 1
            proposals = list
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
        case let .reaction(partyId, username, emoji):
            guard partyId == party?.id, reactionsEnabled else { return }
            onReaction(emoji, username)
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

    private func onReaction(_ emoji: String, _ username: String) {
        let id = nextReactionId
        nextReactionId += 1
        reactions = PartyReactions.appending(reactions, FloatingReaction(id: id, emoji: emoji, username: username, left: .random(in: 0.1...0.9)))
        Task {
            try? await Task.sleep(for: .seconds(PartyReactions.riseSeconds))
            reactions.removeAll { $0.id == id }
        }
    }

    private func closed(reason: String) {
        reset()
        stream.stop()
        show(tr("party.closed_\(reason)"))
        onClosed?(reason)
        onGoHome?()
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
