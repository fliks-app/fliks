import Foundation

enum KaraokeAPI {
    struct Status: Decodable { let enabled: Bool; let ready: Bool }

    struct Stem: Decodable { let size: Int; let durationMs: Int }
    struct Stems: Decodable { let vocals: Stem?; let instrumental: Stem? }

    /// `GET /api/items/:id/karaoke`: the stems and word timings a track has, and the run preparing them.
    struct TrackState: Decodable {
        let state: String
        let stage: String?
        let progress: Double?
        let error: String?
        let fileId: Int
        let stems: Stems
        let lyrics: Bool
        let melody: Bool
        /// An MP3+G track: a `.cdg` graphics file sits next to the audio.
        let cdg: Bool?

        var hasStems: Bool { stems.vocals != nil && stems.instrumental != nil }
        var running: Bool { state == "queued" || state == "running" }
    }

    static func status() async -> Status? { try? await APIClient.shared.get("/api/karaoke/status") }

    static func state(itemId: Int) async -> TrackState? { try? await APIClient.shared.get("/api/items/\(itemId)/karaoke") }

    /// Prepares the track on demand; 202 and 200 both answer its state.
    static func prepare(itemId: Int) async -> TrackState? {
        try? await APIClient.shared.post("/api/items/\(itemId)/karaoke")
    }
}
