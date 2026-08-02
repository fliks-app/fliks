import Foundation

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
    private var streamToken: String?
    private var streamTokenExpiresAt: Date = .distantPast
    private var streamTokenTask: Task<String?, Never>?

    private init() {
        api.refreshTokens = { [weak self] in try await self?.refresh() }
    }

    /// Accounts on the active server that can be signed into without a password.
    var resumableSessions: [StoredSession] { sessions.forServer(ServerStore.shared.url) }

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
        } catch APIError.badStatus(let code) where (400..<500).contains(code) {
            guard sessionEpoch == epoch else { return }
            dropActiveSession()
        } catch {}
    }

    func fetchMe() async throws -> User {
        try await api.get("/api/auth/me")
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
        let user = try await fetchMe()
        startSession(user: user, access: access, refresh: refresh,
                     refreshExpiresAt: Self.msFromSeconds(refreshExpiresAt))
        ServerStore.shared.touchKnownServer(ServerStore.shared.url, username: user.username)
    }

    /// Per-user display preference: libraries kept out of Home and the sidebar.
    /// `User` is immutable, so the profile is re-read rather than patched.
    @MainActor
    func setHiddenLibraries(_ ids: [Int]) async {
        guard let userId = currentUser?.id else { return }
        struct Body: Encodable { let hiddenLibraryIds: [Int] }
        try? await api.put("/api/users/\(userId)", body: Body(hiddenLibraryIds: ids))
        guard let user = try? await fetchMe() else { return }
        currentUser = user
        if let active = sessions.active {
            sessions.updateUser(active.serverUrl, active.user.id, user)
        }
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
        } catch APIError.badStatus(let code) where (400..<500).contains(code) {
            sessions.remove(serverUrl, userId)
            clearInMemorySession()
            return .expired
        } catch {
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
        // Sending this token would hand one server's credential to another host.
        if let target, target.serverUrl != ServerStore.shared.url { throw APIError.badStatus(401) }

        struct Body: Encodable { let refreshToken: String }
        let pair: TokenPair
        do {
            pair = try await api.post("/api/auth/refresh", body: Body(refreshToken: refreshToken))
        } catch APIError.badStatus(let code) where (400..<500).contains(code) {
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
    func requestPairing(userId: Int, deviceName: String, systemName: String?) async throws -> PairingRequestResponse {
        struct Body: Encodable { let userId: Int; let deviceName: String; let systemName: String? }
        return try await api.post(
            "/api/auth/pairing/request",
            body: Body(userId: userId, deviceName: deviceName, systemName: systemName),
            headers: ["X-Device-Id": DeviceId.current]
        )
    }

    func pairingStatus(pairingId: String) async throws -> PairingStatusResponse {
        try await api.get(
            "/api/auth/pairing/status",
            query: ["pairingId": pairingId],
            headers: ["X-Device-Id": DeviceId.current]
        )
    }

    // MARK: - Stream token (12h TTL, refetch once < 30min remain)

    func ensureStreamToken() async -> String? {
        let minRemaining: TimeInterval = 30 * 60
        if let token = streamToken, streamTokenExpiresAt.timeIntervalSinceNow > minRemaining {
            return token
        }
        if let task = streamTokenTask { return await task.value }
        let task = Task<String?, Never> { await self.fetchStreamToken() }
        streamTokenTask = task
        let result = await task.value
        streamTokenTask = nil
        return result
    }

    private func fetchStreamToken() async -> String? {
        struct Response: Decodable { let streamToken: String; let expiresAt: Double }
        do {
            let res: Response = try await api.post("/api/auth/stream-token")
            streamToken = res.streamToken
            // expiresAt is a JS millisecond epoch (Date.now() + ttlMs) — everything
            // else in this file works in UNIX seconds.
            streamTokenExpiresAt = Date(timeIntervalSince1970: res.expiresAt / 1000)
            return res.streamToken
        } catch {
            return nil
        }
    }

    // MARK: - Logout / server switch

    @MainActor
    func logout() async {
        struct Body: Encodable { let refreshToken: String? }
        try? await api.post("/api/auth/logout", body: Body(refreshToken: tokens.refreshToken))
        dropActiveSession()
    }

    /// Wipe credentials scoped to the server just switched away from. No
    /// network round-trip — mirrors the Angular `resetForServerSwitch`.
    @MainActor
    func resetForServerSwitch() {
        refreshTask = nil
        streamTokenTask = nil
        sessions.clearActive()
        clearInMemorySession()
    }

    // MARK: - Session state

    @MainActor
    private func startSession(user: User, access: String?, refresh: String?, refreshExpiresAt: Double?) {
        let serverUrl = ServerStore.shared.url
        tokens.adopt(access: access, refresh: refresh)
        currentUser = user
        if let refresh, !refresh.isEmpty {
            sessions.save(StoredSession(serverUrl: serverUrl, user: user, accessToken: access,
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

    private func adopt(_ session: StoredSession) {
        tokens.adopt(access: session.accessToken, refresh: session.refreshToken)
        currentUser = session.user
        resetStreamToken()
    }

    /// Forget the signed-in session for good — logout, or credentials the
    /// server refused.
    @MainActor
    private func dropActiveSession() {
        if let active = sessions.active { sessions.remove(active.serverUrl, active.user.id) }
        clearInMemorySession()
    }

    /// Drop everything session-bound from memory, leaving stored sessions alone.
    @MainActor
    private func clearInMemorySession() {
        currentUser = nil
        tokens.clear()
        WatchedStore.shared.clear()
        resetStreamToken()
        state = .signedOut
        bumpEpoch()
    }

    /// The stream token authenticates playback URLs as one account — it must
    /// never outlive the session that minted it.
    private func resetStreamToken() {
        streamToken = nil
        streamTokenExpiresAt = .distantPast
        streamTokenTask = nil
    }

    private func bumpEpoch() { sessionEpoch &+= 1 }

    /// The backend reports expiries as UNIX seconds; the store keeps ms.
    private static func msFromSeconds(_ seconds: Int?) -> Double? {
        guard let seconds, seconds > 0 else { return nil }
        return Double(seconds) * 1000
    }
}
