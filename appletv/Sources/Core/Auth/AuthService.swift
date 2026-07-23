import Foundation

/// Session state + quick-connect pairing + token lifecycle. Every request goes
/// through the generic `APIClient` (no per-endpoint client methods) — this
/// class only supplies the small `Encodable` request bodies and owns the
/// `refreshTokens` seam.
@Observable final class AuthService {
    static let shared = AuthService()

    enum State: Equatable {
        case signedOut
        case connecting
        case signedIn
    }

    var state: State = .signedOut
    var currentUser: User?

    private let api = APIClient.shared
    private let tokens = TokenStore.shared

    private var refreshTask: Task<Void, Error>?
    private var streamToken: String?
    private var streamTokenExpiresAt: Date = .distantPast
    private var streamTokenTask: Task<String?, Never>?

    private init() {
        api.refreshTokens = { [weak self] in try await self?.refresh() }
    }

    // MARK: - Launch hydrate

    /// Tokens are already loaded from the Keychain by `TokenStore.shared`'s
    /// init; this validates them against the server.
    @MainActor
    func bootstrap() async {
        guard tokens.accessToken != nil || tokens.refreshToken != nil else {
            state = .signedOut
            return
        }
        state = .connecting
        do {
            currentUser = try await fetchMe()
            state = .signedIn
        } catch {
            state = .signedOut
        }
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
        tokens.setTokens(access: res.accessToken, refresh: res.refreshToken)
        currentUser = res.user
        state = .signedIn
        ServerStore.shared.touchKnownServer(ServerStore.shared.url, username: res.user.username)
    }

    /// Adopt a token pair minted by another channel (quick-connect approval).
    @MainActor
    func loginWithToken(access: String, refresh: String?) async throws {
        tokens.accessToken = access
        if let refresh { tokens.refreshToken = refresh }
        let user = try await fetchMe()
        currentUser = user
        state = .signedIn
        ServerStore.shared.touchKnownServer(ServerStore.shared.url, username: user.username)
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

    // MARK: - Refresh (single-flight)

    /// Rotates the refresh token. 4xx is terminal (expired/revoked/theft
    /// detection): purge the session and drop back to signed-out. Network/5xx
    /// keeps the tokens — a flaky connection shouldn't log the user out.
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

    @MainActor
    private func performRefresh() async throws {
        guard let refreshToken = tokens.refreshToken else { throw APIError.badStatus(401) }
        struct Body: Encodable { let refreshToken: String }
        do {
            let pair: TokenPair = try await api.post("/api/auth/refresh", body: Body(refreshToken: refreshToken))
            tokens.setTokens(access: pair.accessToken, refresh: pair.refreshToken)
        } catch APIError.badStatus(let code) where (400..<500).contains(code) {
            clearLocalSession()
            throw APIError.badStatus(code)
        }
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
        clearLocalSession()
    }

    /// Wipe credentials scoped to the server just switched away from. No
    /// network round-trip — mirrors the Angular `resetForServerSwitch`.
    @MainActor
    func resetForServerSwitch() {
        refreshTask = nil
        streamTokenTask = nil
        clearLocalSession()
    }

    @MainActor
    private func clearLocalSession() {
        currentUser = nil
        tokens.clear()
        streamToken = nil
        streamTokenExpiresAt = .distantPast
        state = .signedOut
    }
}
