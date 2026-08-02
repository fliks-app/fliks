import Foundation

/// Credentials of the signed-in session. In memory only — `SessionStore` owns
/// persistence, so leaving an account doesn't destroy its stored tokens.
/// `APIClient` reads `accessToken` for the Bearer header.
@Observable final class TokenStore {
    static let shared = TokenStore()

    private(set) var accessToken: String?
    private(set) var refreshToken: String?

    private init() {}

    func adopt(access: String?, refresh: String?) {
        accessToken = access
        refreshToken = refresh
    }

    func clear() {
        accessToken = nil
        refreshToken = nil
    }
}
