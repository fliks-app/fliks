import Foundation

/// A `notification` SSE event, already rendered in the connection's language by the server.
struct ServerNotification: Decodable, Equatable {
    let id: String
    let title: String
    let body: String
    let image: String?
    let tag: String?
    let ttl: Double?
}

/// The foreground notification stream and the one toast it shows. No `device` is sent, so the
/// connection is never a remote target; a notification with the same `tag` replaces the shown one.
@MainActor @Observable
final class NotificationToastService {
    static let shared = NotificationToastService()
    static let seconds = 6.0

    private(set) var current: ServerNotification?
    @ObservationIgnored private let stream = ServerEventStream()
    @ObservationIgnored private var dismiss: Task<Void, Never>?
    @ObservationIgnored private var seen = Set<String>()

    private init() {
        stream.onEvent = { [weak self] data in
            guard let event = Self.decode(data) else { return }
            self?.show(event)
        }
    }

    func start() { stream.start(deviceId: nil) }

    func stop() {
        stream.stop()
        dismiss?.cancel()
        current = nil
    }

    nonisolated static func decode(_ data: Data) -> ServerNotification? {
        struct Head: Decodable { let type: String }
        guard let head = try? JSONDecoder().decode(Head.self, from: data), head.type == "notification" else { return nil }
        return try? JSONDecoder().decode(ServerNotification.self, from: data)
    }

    private func show(_ event: ServerNotification) {
        guard seen.insert(event.id).inserted else { return }
        current = event
        dismiss?.cancel()
        dismiss = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.seconds))
            if !Task.isCancelled { self?.current = nil }
        }
    }
}
