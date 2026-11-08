import Foundation

/// The party's karaoke relay socket in the display role: singers' pitch batches arrive stamped with their
/// user id. Only the party host may open it; the socket is not resumed, so each redial mints a fresh ticket.
@MainActor final class KaraokeRelay {
    static let retry: Duration = .seconds(2)

    var onBatch: ((Int, [PitchFrame]) -> Void)?
    private var task: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?

    /// The socket URL of the relay endpoint `http`, as `wss://...?role=display&ticket=...`.
    nonisolated static func url(_ http: String, ticket: String) -> URL? {
        guard var c = URLComponents(string: http), c.host != nil else { return nil }
        c.scheme = c.scheme == "https" ? "wss" : "ws"
        c.queryItems = [URLQueryItem(name: "role", value: "display"), URLQueryItem(name: "ticket", value: ticket)]
        return c.url
    }

    func open(partyId: Int) {
        guard task == nil else { return }
        task = Task { [weak self] in
            while !Task.isCancelled {
                await self?.run(partyId: partyId)
                try? await Task.sleep(for: Self.retry)
            }
        }
    }

    func close() {
        task?.cancel()
        task = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
    }

    /// One connection, until the socket drops.
    private func run(partyId: Int) async {
        struct Ticket: Decodable { let ticket: String }
        guard let ticket: Ticket = try? await APIClient.shared.post("/api/system/events/ticket"),
              let url = Self.url(ServerStore.shared.resolveUrl("/api/parties/\(partyId)/karaoke/ws"), ticket: ticket.ticket) else { return }
        let ws = URLSession.shared.webSocketTask(with: url)
        socket = ws
        ws.resume()
        while !Task.isCancelled, let message = try? await ws.receive() {
            if case .string(let text) = message, let m = decodeRelayed(text) { onBatch?(m.userId, m.frames) }
        }
        ws.cancel(with: .goingAway, reason: nil)
    }
}
