import Foundation

/// The relay the app talks to, whatever the server says: only these hosts are accepted as a ticket audience.
enum PushRelay {
    /// `DEFAULT_RELAY_URL` of `server/crates/server/src/push/mod.rs`, official host undecided.
    static let officialHost = "relay.fliks.app"
    static let hosts: [String] = {
        var list = [officialHost]
        #if DEBUG
        list.append("localhost")
        #endif
        return list
    }()

    struct Ticket: Equatable {
        let key: String
        let sub: String
        let audience: String
    }

    /// The signature is the relay's to check; the device checks the shape and the audience.
    static func ticket(_ raw: String) -> Ticket? {
        guard let body = raw.split(separator: ".").first.flatMap({ Data(base64URL: String($0)) }),
              let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let key = json["key"] as? String, Data(base64URL: key)?.count == 32,
              let sub = json["sub"] as? String, Data(base64URL: sub)?.count == 16,
              let aud = json["aud"] as? String, baseURL(audience: aud) != nil else { return nil }
        return Ticket(key: key, sub: sub, audience: aud)
    }

    static var defaultURL: URL { baseURL(audience: officialHost)! }

    static func baseURL(audience: String) -> URL? {
        guard let host = audience.split(separator: ":").first.map(String.init), hosts.contains(host) else { return nil }
        return URL(string: (host == "localhost" ? "http://" : "https://") + audience)
    }

    /// The HTTP status, nil when the relay could not be reached.
    static func put(_ base: URL, ticket: String, token: String, environment: String) async -> Int? {
        await send("PUT", base, ["ticket": ticket, "platform": "apns", "token": token, "env": environment])
    }

    static func delete(_ base: URL, token: String, sub: String?) async -> Int? {
        var body = ["platform": "apns", "token": token]
        if let sub { body["sub"] = sub }
        return await send("DELETE", base, body)
    }

    private static func send(_ method: String, _ base: URL, _ body: [String: String]) async -> Int? {
        var request = URLRequest(url: base.appendingPathComponent("v1/subscriptions"), timeoutInterval: 10)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        return (try? await URLSession.shared.data(for: request)).flatMap { ($0.1 as? HTTPURLResponse)?.statusCode }
    }
}
