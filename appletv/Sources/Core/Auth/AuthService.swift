import Foundation
import os

/// Session state + quick-connect pairing + token lifecycle. Every request goes
/// through the generic `APIClient` (no per-endpoint client methods) — this
/// class only supplies the small `Encodable` request bodies and owns the
/// `refreshTokens` seam.
///
/// Credentials of every account signed in on this device live in
/// `SessionStore`; leaving one only moves the active pointer, so coming back
/// needs no password.
@Observable final class AuthService {
    static let shared = AuthService()

    enum State: Equatable {
        case signedOut
        case connecting
        case signedIn
    }

    /// Why a resume ended: signed in, credentials refused, or server unreachable.
    enum ResumeOutcome {
        case resumed
        case expired
        case unreachable
    }

    var state: State = .signedOut
    var currentUser: User?

    private let api = APIClient.shared
    private let tokens = TokenStore.shared
    private let sessions = SessionStore.shared

    /// Bumped whenever the signed-in session changes. A refresh in flight for
    /// the account being left must not install its new pair over the one that
    /// took over.
    private var sessionEpoch = 0

    private var refreshTask: Task<Void, Error>?
    /// Stream tokens, one per media file: a leaked playback URL opens that file only.
    private var streamTokens: [Int: (token: String, expiresAt: Date)] = [:]
    private var streamTokenTasks: [Int: Task<String?, Never>] = [:]

    private init() {
        api.refreshTokens = { [weak self] in try await self?.refresh() }
    }

    /// Accounts on the active server that can be signed into without a password.
    var resumableSessions: [StoredSession] { sessions.forServer(ServerStore.shared.url) }

    /// Storage scope of the signed-in account, the key `SessionStore` files its session under.
    var scope: String? { currentUser.map { SessionStore.key(ServerStore.shared.url, $0.id) } }

    /// A refusal of the credentials themselves; a proxy's 404, 408 or 429 during an upgrade is not one.
    private static func refused(_ code: Int) -> Bool { code == 401 || code == 403 }

    // MARK: - Launch hydrate

    /// Adopts the active session's stored profile so the shell renders at once,
    /// then confirms it against the server.
    @MainActor
    func bootstrap() async {
        guard let session = sessions.active, session.serverUrl == ServerStore.shared.url else {
            sessions.clearActive()
            state = .signedOut
            return
        }
        adopt(session)
        state = .signedIn
        bumpEpoch()
        await validateActiveSession()
    }

    /// A rejection that survived the client's rotation means the credentials are
    /// dead; a network error keeps the stored profile so a flaky boot doesn't
    /// drop the user back to the picker.
    @MainActor
    private func validateActiveSession() async {
        let epoch = sessionEpoch
        do {
            let user = try await fetchMe()
            guard sessionEpoch == epoch, let active = sessions.active else { return }
            currentUser = user
            sessions.updateUser(active.serverUrl, active.user.id, user)
        } catch APIError.badStatus(let code, _) where Self.refused(code) {
            guard sessionEpoch == epoch else { return }
            Log.auth.notice("stored session refused (\(code, privacy: .public)), signing out")
            dropActiveSession()
        } catch {
            Log.auth.error("session check failed, keeping the stored profile: \(String(describing: error), privacy: .public)")
        }
    }

    func fetchMe() async throws -> User {
        try await api.get("/api/auth/me")
    }

    /// Whether the server advertises a capability flag; false until a live response confirms it.
    func hasServerFeature(_ feature: String) -> Bool {
        currentUser?.features?.contains(feature) ?? false
    }

    // MARK: - Password login

    @MainActor
    func login(username: String, password: String) async throws {
        struct Body: Encodable { let username: String; let password: String }
        let res: LoginResponse = try await api.post(
            "/api/auth/login",
            body: Body(username: username, password: password)
        )
        startSession(user: res.user, access: res.accessToken, refresh: res.refreshToken,
                     refreshExpiresAt: Self.msFromSeconds(res.refreshTokenExpiresAt))
        ServerStore.shared.touchKnownServer(ServerStore.shared.url, username: res.user.username)
    }

    /// Adopt a token pair minted by another channel (quick-connect approval).
    @MainActor
    func loginWithToken(access: String, refresh: String?, refreshExpiresAt: Int? = nil) async throws {
        tokens.adopt(access: access, refresh: refresh)
        let user: User
        do {
            user = try await fetchMeRetrying()
        } catch {
            tokens.clear()
            throw error
        }
        startSession(user: user, access: access, refresh: refresh,
                     refreshExpiresAt: Self.msFromSeconds(refreshExpiresAt))
        ServerStore.shared.touchKnownServer(ServerStore.shared.url, username: user.username)
    }

    /// The server hands an approved pairing's tokens out once, so a transient failure of the first
    /// `/auth/me` must not lose them: only a refusal of the token itself ends the retries.
    private func fetchMeRetrying(attempts: Int = 3) async throws -> User {
        for _ in 1..<attempts {
            do {
                return try await fetchMe()
            } catch APIError.badStatus(let code, let message) where (400..<500).contains(code) {
                throw APIError.badStatus(code, message: message)
            } catch {
                try await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
        return try await fetchMe()
    }

    /// Per-user library order and the libraries kept out of Home and the rail. The profile changes at once,
    /// so every screen follows; the server's answer either confirms it or puts the previous values back.
    @MainActor
    func setLibraryPrefs(order: [Int], hidden: [Int]) {
        guard let user = currentUser else { return }
        let previous = (user.libraryOrder, user.hiddenLibraryIds)
        let epoch = sessionEpoch
        patchCurrentUser { $0.libraryOrder = order; $0.hiddenLibraryIds = hidden }
        Task { @MainActor in
            struct Body: Encodable { let libraryOrder: [Int]; let hiddenLibraryIds: [Int] }
            do {
                try await api.put("/api/users/\(user.id)", body: Body(libraryOrder: order, hiddenLibraryIds: hidden))
            } catch {
                Log.library.error("saving the library prefs failed: \(String(describing: error), privacy: .public)")
                guard sessionEpoch == epoch, currentUser?.libraryOrder == order,
                      currentUser?.hiddenLibraryIds == hidden else { return }
                patchCurrentUser { $0.libraryOrder = previous.0; $0.hiddenLibraryIds = previous.1 }
            }
        }
    }

    @MainActor
    private func patchCurrentUser(_ change: (inout User) -> Void) {
        guard var user = currentUser else { return }
        change(&user)
        currentUser = user
        if let active = sessions.active { sessions.updateUser(active.serverUrl, active.user.id, user) }
    }

    // MARK: - Switching account

    /// Sign back into a stored session — no password, no quick-connect. The
    /// stored tokens are adopted as-is and rotated lazily on a 401: a rotation
    /// whose new pair never reaches storage reads as theft on the backend,
    /// which revokes every session of the account.
    @MainActor
    func resumeSession(userId: Int) async -> ResumeOutcome {
        let serverUrl = ServerStore.shared.url
        guard let stored = sessions.get(serverUrl, userId) else { return .expired }

        clearInMemorySession()
        sessions.setActive(serverUrl, userId)
        adopt(stored)
        state = .signedIn
        bumpEpoch()

        do {
            let user = try await fetchMe()
            // The server may answer as somebody else — a token that never
            // belonged to this account.
            guard user.id == userId else {
                sessions.remove(serverUrl, userId)
                clearInMemorySession()
                return .expired
            }
            currentUser = user
            sessions.updateUser(serverUrl, userId, user)
            return .resumed
        } catch APIError.badStatus(let code, _) where Self.refused(code) {
            sessions.remove(serverUrl, userId)
            clearInMemorySession()
            return .expired
        } catch {
            Log.auth.error("resuming a session failed: \(String(describing: error), privacy: .public)")
            clearInMemorySession()
            return .unreachable
        }
    }

    /// Leave the current account without logging it out: its session stays
    /// stored, and the picker offers it back in one click.
    @MainActor
    func switchUser() {
        sessions.clearActive()
        clearInMemorySession()
    }

    // MARK: - Refresh (single-flight)

    @MainActor
    func refresh() async throws {
        if let task = refreshTask {
            try await task.value
            return
        }
        let task = Task<Void, Error> { @MainActor in
            try await self.performRefresh()
        }
        refreshTask = task
        defer { refreshTask = nil }
        try await task.value
    }

    /// 4xx is terminal (expired/revoked/theft detection): purge the session and
    /// drop back to signed-out. Network/5xx keeps the tokens — a flaky
    /// connection shouldn't log the user out.
    @MainActor
    private func performRefresh() async throws {
        guard let refreshToken = tokens.refreshToken else { throw APIError.badStatus(401) }
        let target = sessions.active
        let epoch = sessionEpoch
        // Sending this token would hand one server's credential to another host: leave the account instead.
        if let target, target.serverUrl != ServerStore.shared.url {
            Log.auth.error("the active session belongs to another server, signing out")
            if sessionEpoch == epoch {
                sessions.clearActive()
                clearInMemorySession()
            }
            throw APIError.badStatus(401)
        }

        struct Body: Encodable { let refreshToken: String }
        let pair: TokenPair
        do {
            pair = try await api.post("/api/auth/refresh", body: Body(refreshToken: refreshToken))
        } catch APIError.badStatus(let code, _) where (400..<500).contains(code) {
            if sessionEpoch == epoch {
                dropActiveSession()
            } else if let target {
                sessions.remove(target.serverUrl, target.user.id)
            }
            throw APIError.badStatus(code)
        }

        // Persisted before anything else touches the pair: the presented token
        // is already revoked server-side, so a lost rotation locks the account out.
        if let target {
            sessions.updateTokens(target.serverUrl, target.user.id,
                                  access: pair.accessToken, refresh: pair.refreshToken,
                                  refreshExpiresAt: Self.msFromSeconds(pair.refreshTokenExpiresAt))
        }
        // Another session took over meanwhile; installing the pair here would
        // authenticate it as the account we just left.
        guard sessionEpoch == epoch else { throw APIError.badStatus(401) }
        tokens.adopt(access: pair.accessToken, refresh: pair.refreshToken)
    }

    // MARK: - Pairing (quick connect)

    /// TV-side request. The access token this pairing eventually mints is
    /// only ever handed back to a status poll carrying this same device id.
    func requestPairing(userId: Int?, deviceName: String, systemName: String?) async throws -> PairingRequestResponse {
        // Optional encodes by omission: no `userId` key without a picked user.
        struct Body: Encodable { let userId: Int?; let deviceName: String; let systemName: String? }
        return try await api.post(
            "/api/auth/pairing/request",
            body: Body(userId: userId, deviceName: deviceName, systemName: systemName),
            headers: ["X-Device-Id": DeviceId.current, "X-Fliks-Pairing-Code": "1"]
        )
    }

    func pairingStatus(pairingId: String) async throws -> PairingStatusResponse {
        try await api.get(
            "/api/auth/pairing/status",
            query: ["pairingId": pairingId],
            headers: ["X-Device-Id": DeviceId.current]
        )
    }

    // MARK: - Stream token (bound to one file, refetched once < 30min remain)

    @MainActor
    func ensureStreamToken(mediaFileId: Int) async -> String? {
        let minRemaining: TimeInterval = 30 * 60
        if let known = streamTokens[mediaFileId], known.expiresAt.timeIntervalSinceNow > minRemaining {
            return known.token
        }
        if let task = streamTokenTasks[mediaFileId] { return await task.value }
        let epoch = sessionEpoch
        let task = Task<String?, Never> { @MainActor in await self.mintStreamToken(mediaFileId: mediaFileId, epoch: epoch) }
        streamTokenTasks[mediaFileId] = task
        return await task.value
    }

    /// Forgets a file's token, for a stream URL the server refused.
    @MainActor
    func discardStreamToken(mediaFileId: Int) {
        streamTokens[mediaFileId] = nil
    }

    /// A mint that finishes after the account changed belongs to the account left, and is dropped.
    @MainActor
    private func mintStreamToken(mediaFileId: Int, epoch: Int) async -> String? {
        struct Body: Encodable { let mediaFileId: Int }
        struct Response: Decodable { let streamToken: String; let expiresAt: Double }
        defer { if sessionEpoch == epoch { streamTokenTasks[mediaFileId] = nil } }
        do {
            let res: Response = try await api.post("/api/auth/stream-token", body: Body(mediaFileId: mediaFileId))
            guard sessionEpoch == epoch else { return nil }
            // expiresAt is a JS millisecond epoch (Date.now() + ttlMs) — everything
            // else in this file works in UNIX seconds.
            streamTokens[mediaFileId] = (res.streamToken, Date(timeIntervalSince1970: res.expiresAt / 1000))
            return res.streamToken
        } catch {
            Log.auth.error("stream token for file \(mediaFileId, privacy: .public) failed: \(String(describing: error), privacy: .public)")
            return nil
        }
    }

    // MARK: - Logout / server switch

    @MainActor
    func logout() async {
        struct Body: Encodable { let refreshToken: String? }
        let body = Body(refreshToken: tokens.refreshToken)
        let bearer = APIClient.bearerHeader
        dropActiveSession()
        // Revoking server-side is best effort: signing out never waits on the server.
        Task { [api] in try? await api.post("/api/auth/logout", body: body, headers: bearer) }
    }

    /// Wipe credentials scoped to the server just switched away from. No
    /// network round-trip — mirrors the Angular `resetForServerSwitch`.
    @MainActor
    func resetForServerSwitch() {
        refreshTask = nil
        sessions.clearActive()
        clearInMemorySession()
    }

    // MARK: - Session state

    @MainActor
    private func startSession(user: User, access: String?, refresh: String?, refreshExpiresAt: Double?) {
        let serverUrl = ServerStore.shared.url
        tokens.adopt(access: access, refresh: refresh)
        currentUser = user
        rescopeStores()
        if let refresh, !refresh.isEmpty {
            sessions.save(StoredSession(serverUrl: serverUrl, user: StoredProfile(user), accessToken: access,
                                        refreshToken: refresh, refreshExpiresAt: refreshExpiresAt,
                                        lastUsedAt: SessionStore.nowMs()))
            sessions.setActive(serverUrl, user.id)
        } else {
            // Nothing to resume later, so nothing may stay flagged as signed in.
            sessions.clearActive()
        }
        resetStreamToken()
        state = .signedIn
        bumpEpoch()
    }

    @MainActor
    private func adopt(_ session: StoredSession) {
        tokens.adopt(access: session.accessToken, refresh: session.refreshToken)
        currentUser = User(restoring: session.user)
        rescopeStores()
        resetStreamToken()
    }

    /// Forget the signed-in session for good — logout, or credentials the
    /// server refused.
    @MainActor
    private func dropActiveSession() {
        if let active = sessions.active { sessions.remove(active.serverUrl, active.user.id) }
        clearInMemorySession()
    }

    /// The one reset point of everything bound to the signed-in account, leaving stored sessions alone:
    /// what plays, the party, the remote target and every per-account store.
    @MainActor
    private func clearInMemorySession() {
        MusicPlayer.shared.stop()
        PartyService.shared.resetForSignOut()
        RemoteControlService.shared.reset()
        currentUser = nil
        tokens.clear()
        WatchedStore.shared.clear()
        LibraryStore.shared.clear()
        rescopeStores()
        resetStreamToken()
        state = .signedOut
        bumpEpoch()
    }

    /// The preference stores follow the account that is signed in.
    @MainActor
    func rescopeStores() {
        AppSettingsStore.shared.rescope()
        HomeSettingsStore.shared.rescope()
    }

    /// Stream tokens authenticate playback URLs as one account: they must
    /// never outlive the session that minted them.
    @MainActor
    private func resetStreamToken() {
        streamTokens = [:]
        streamTokenTasks = [:]
    }

    private func bumpEpoch() { sessionEpoch &+= 1 }

    /// The backend reports expiries as UNIX seconds; the store keeps ms.
    private static func msFromSeconds(_ seconds: Int?) -> Double? {
        guard let seconds, seconds > 0 else { return nil }
        return Double(seconds) * 1000
    }
}
