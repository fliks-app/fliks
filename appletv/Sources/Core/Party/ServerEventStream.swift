import Foundation
import UIKit

/// The server's SSE stream, opened with a one-time ticket and re-opened with a fresh one after every drop.
/// The app polls everything else; only a watch party needs it, so it runs only while one is joined.
@MainActor
final class ServerEventStream {
    private(set) var connected = false
    private var task: Task<Void, Never>?
    private let session: URLSession

    var onEvent: ((Data) -> Void)?
    var onConnectionChange: ((Bool) -> Void)?

    init() {
        let config = URLSessionConfiguration.default
        // The server pings every 30 s: a longer silence is a dead link.
        config.timeoutIntervalForRequest = 75
        config.timeoutIntervalForResource = .infinity
        session = URLSession(configuration: config)
    }

    func start(deviceId: String) {
        guard task == nil else { return }
        task = Task { [weak self] in
            var delay = 1.0
            while !Task.isCancelled {
                let opened = await self?.run(deviceId: deviceId) ?? false
                self?.setConnected(false)
                if Task.isCancelled { return }
                delay = opened ? 1 : min(delay * 2, 10)
                try? await Task.sleep(for: .seconds(delay))
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
        setConnected(false)
    }

    private func setConnected(_ value: Bool) {
        guard connected != value else { return }
        connected = value
        onConnectionChange?(value)
    }

    private struct Ticket: Decodable { let ticket: String }

    /// One connection; true when it reached `sse.connected` before ending.
    private func run(deviceId: String) async -> Bool {
        do {
            let ticket: Ticket = try await APIClient.shared.post("/api/system/events/ticket")
            guard var comps = URLComponents(string: ServerStore.shared.resolveUrl("/api/system/events")) else { return false }
            comps.queryItems = [
                URLQueryItem(name: "ticket", value: ticket.ticket),
                URLQueryItem(name: "device", value: deviceId),
                URLQueryItem(name: "ff", value: "tv"),
                URLQueryItem(name: "name", value: UIDevice.current.name),
            ]
            guard let url = comps.url else { return false }
            var req = URLRequest(url: url)
            req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            let (bytes, response) = try await session.bytes(for: req)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return false }
            var parser = SSEParser()
            var opened = false
            for try await byte in bytes {
                guard let message = parser.feed(byte), message.event == nil else { continue }
                let data = Data(message.data.utf8)
                if !opened, message.data.contains("\"sse.connected\"") {
                    opened = true
                    setConnected(true)
                }
                onEvent?(data)
            }
            return opened
        } catch {
            return false
        }
    }
}
