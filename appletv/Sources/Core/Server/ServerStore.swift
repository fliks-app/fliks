import Foundation

/// One server the user previously connected to. Mirrors the Angular
/// `KnownServer` shape (`ServerConfigService`), stored as JSON so the
/// tvOS setup screen (later phase) can offer "recent servers" too.
struct KnownServer: Codable, Identifiable, Hashable {
    var url: String
    var name: String?
    var lastUsedAt: Double
    var lastUsername: String?

    var id: String { url }
}

/// Active server URL + known-servers list. tvOS always talks to an
/// explicit server (no same-origin bundle like the web client), so
/// every API path is resolved against `url` here.
@Observable final class ServerStore {
    static let shared = ServerStore()

    private static let urlKey = "fliks_server_url"
    private static let knownKey = "fliks_known_servers"
    private static let maxKnown = 10

    var url: String {
        didSet { UserDefaults.standard.set(url, forKey: Self.urlKey) }
    }
    var knownServers: [KnownServer] {
        didSet { persistKnown() }
    }

    var isConfigured: Bool { !url.isEmpty }

    private init() {
        url = UserDefaults.standard.string(forKey: Self.urlKey) ?? ""
        if let data = UserDefaults.standard.data(forKey: Self.knownKey),
           let decoded = try? JSONDecoder().decode([KnownServer].self, from: data) {
            knownServers = decoded
        } else {
            knownServers = []
        }
    }

    func save(_ newUrl: String) {
        url = Self.trimTrailingSlashes(newUrl)
    }

    func clear() {
        url = ""
    }

    /// A server typed as `http://` that answers with a redirect to `https://`
    /// is stored by its https address: later requests skip the hop instead of
    /// making every write survive it, and image URLs stop being downgraded.
    ///
    /// Port comes from the redirect target, not from what was typed — a server
    /// reached on `:8096` usually answers TLS on 443.
    @MainActor
    func upgradeToHTTPS(redirectedTo target: URL) {
        guard var comps = URLComponents(string: url), comps.scheme == "http",
              target.scheme == "https", comps.host == target.host else { return }
        let previous = url
        comps.scheme = "https"
        comps.port = target.port
        guard let upgraded = comps.string else { return }
        let known = knownServers.first { $0.url == previous }
        save(upgraded)
        forgetKnownServer(previous)
        touchKnownServer(upgraded, name: known?.name, username: known?.lastUsername)
    }

    /// Append to the known list, or bump `lastUsedAt` if already present.
    func touchKnownServer(_ serverUrl: String, name: String? = nil, username: String? = nil) {
        let cleaned = Self.trimTrailingSlashes(serverUrl)
        guard !cleaned.isEmpty else { return }
        let existing = knownServers.first { $0.url == cleaned }
        let merged = KnownServer(
            url: cleaned,
            name: name ?? existing?.name,
            lastUsedAt: Date().timeIntervalSince1970,
            lastUsername: username ?? existing?.lastUsername
        )
        let rest = knownServers.filter { $0.url != cleaned }
        knownServers = ([merged] + rest)
            .sorted { $0.lastUsedAt > $1.lastUsedAt }
            .prefix(Self.maxKnown)
            .map { $0 }
    }

    func forgetKnownServer(_ serverUrl: String) {
        let cleaned = Self.trimTrailingSlashes(serverUrl)
        knownServers.removeAll { $0.url == cleaned }
    }

    /// Absolute URLs (e.g. a raw external image) pass through unchanged;
    /// everything else is prefixed with the active server.
    func resolveUrl(_ path: String) -> String {
        guard isConfigured else { return path }
        let lower = path.lowercased()
        if lower.hasPrefix("http://") || lower.hasPrefix("https://") { return path }
        return url + path
    }

    private func persistKnown() {
        if let data = try? JSONEncoder().encode(knownServers) {
            UserDefaults.standard.set(data, forKey: Self.knownKey)
        }
    }

    private static func trimTrailingSlashes(_ s: String) -> String {
        var s = s
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }
}
