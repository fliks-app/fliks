import Foundation

enum APIError: Error, CustomStringConvertible {
    case badURL
    case badStatus(Int)
    case transport(String)
    case decoding(String)

    var description: String {
        switch self {
        case .badURL: return "Invalid URL"
        case .badStatus(let code): return "HTTP \(code)"
        case .transport(let msg): return msg
        case .decoding(let msg): return "decode: \(msg)"
        }
    }
}

/// Nest serializes `Date` via `JSON.stringify`, which always emits
/// milliseconds (`2024-01-01T12:00:00.123Z`) — the plain `.iso8601` strategy
/// has no fractional-seconds support and fails to decode those.
private enum ISO8601 {
    static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    static let plain = ISO8601DateFormatter()
}

extension JSONDecoder {
    static let fliks: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let str = try container.decode(String.self)
            if let date = ISO8601.withFraction.date(from: str) ?? ISO8601.plain.date(from: str) {
                return date
            }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid ISO8601 date: \(str)")
        }
        return d
    }()
}

extension JSONEncoder {
    static let fliks: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(ISO8601.withFraction.string(from: date))
        }
        return e
    }()
}

/// Generic async REST client. Base URL comes from `ServerStore`, the Bearer
/// token from `TokenStore` — every `/api/*` request except `/auth/refresh`
/// carries `Authorization: Bearer <access>` (mirrors the native branch of
/// the Angular `credentialsInterceptor`).
///
/// AuthService doesn't exist yet in P1 — `refreshTokens` is the seam P2
/// wires up. It must rotate the tokens in `TokenStore` on success and throw
/// on failure; a 401 triggers one single-flight refresh + one replay.
final class APIClient {
    static let shared = APIClient()

    var refreshTokens: (() async throws -> Void)?

    private let session: URLSession
    private var refreshTask: Task<Void, Error>?

    init(session: URLSession = .shared) {
        self.session = session
    }

    func get<T: Decodable>(_ path: String, query: [String: String] = [:], headers: [String: String] = [:]) async throws -> T {
        try await request(path, method: "GET", query: query, body: nil, headers: headers)
    }

    func post<T: Decodable, B: Encodable>(_ path: String, body: B, headers: [String: String] = [:]) async throws -> T {
        try await request(path, method: "POST", query: [:], body: try JSONEncoder.fliks.encode(body), headers: headers)
    }

    func post<T: Decodable>(_ path: String) async throws -> T {
        try await request(path, method: "POST", query: [:], body: nil)
    }

    func post<B: Encodable>(_ path: String, body: B) async throws {
        try await requestVoid(path, method: "POST", body: try JSONEncoder.fliks.encode(body))
    }

    func post(_ path: String) async throws {
        try await requestVoid(path, method: "POST", body: nil)
    }

    func put<T: Decodable, B: Encodable>(_ path: String, body: B) async throws -> T {
        try await request(path, method: "PUT", query: [:], body: try JSONEncoder.fliks.encode(body))
    }

    func put<B: Encodable>(_ path: String, body: B) async throws {
        try await requestVoid(path, method: "PUT", body: try JSONEncoder.fliks.encode(body))
    }

    func delete(_ path: String) async throws {
        try await requestVoid(path, method: "DELETE", body: nil)
    }

    func delete<B: Encodable>(_ path: String, body: B) async throws {
        try await requestVoid(path, method: "DELETE", body: try JSONEncoder.fliks.encode(body))
    }

    // MARK: -

    private func request<T: Decodable>(
        _ path: String,
        method: String,
        query: [String: String],
        body: Data?,
        headers: [String: String] = [:],
        isRetry: Bool = false
    ) async throws -> T {
        let (data, _) = try await raw(path, method: method, query: query, body: body, headers: headers, isRetry: isRetry)
        do {
            return try JSONDecoder.fliks.decode(T.self, from: data)
        } catch {
            throw APIError.decoding("\(T.self): \(error)")
        }
    }

    private func requestVoid(_ path: String, method: String, body: Data?, isRetry: Bool = false) async throws {
        _ = try await raw(path, method: method, query: [:], body: body, headers: [:], isRetry: isRetry)
    }

    private func raw(
        _ path: String,
        method: String,
        query: [String: String],
        body: Data?,
        headers: [String: String] = [:],
        isRetry: Bool
    ) async throws -> (Data, HTTPURLResponse) {
        guard var comps = URLComponents(string: ServerStore.shared.resolveUrl(path)) else {
            throw APIError.badURL
        }
        if !query.isEmpty {
            comps.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        guard let url = comps.url else { throw APIError.badURL }

        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")

        // The refresh endpoint itself never gets a Bearer header or a retry —
        // if it 401s, it's terminal (matches the Angular interceptor).
        let isRefreshCall = path.hasSuffix("/auth/refresh")
        if !isRefreshCall, let token = TokenStore.shared.accessToken {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        for (key, value) in headers {
            req.setValue(value, forHTTPHeaderField: key)
        }
        req.httpBody = body

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw APIError.transport(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else {
            throw APIError.transport("non-HTTP response")
        }

        if http.statusCode == 401, !isRefreshCall, !isRetry, refreshTokens != nil {
            try await refreshOnce()
            return try await raw(path, method: method, query: query, body: body, headers: headers, isRetry: true)
        }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.badStatus(http.statusCode)
        }
        return (data, http)
    }

    /// Concurrent 401s share one in-flight refresh so the server only rotates once.
    private func refreshOnce() async throws {
        if let task = refreshTask {
            try await task.value
            return
        }
        guard let refresh = refreshTokens else { return }
        let task = Task { try await refresh() }
        refreshTask = task
        defer { refreshTask = nil }
        try await task.value
    }
}
