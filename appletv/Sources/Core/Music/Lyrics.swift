import Foundation

/// `GET /api/items/:id/lyrics?enhanced=true`, the OpenSubsonic `songLyrics` v2 shape (times in ms).
struct LyricsResponse: Decodable {
    let structuredLyrics: [StructuredLyrics]
}

struct StructuredLyrics: Decodable {
    struct Line: Decodable { let start: Int?; let value: String }
    struct Cue: Decodable {
        let start: Int
        let end: Int
        let value: String
        /// MIDI note of the reference melody, absent when unvoiced or unknown.
        let pitch: Double?
        let golden: Bool?
    }
    struct Agent: Decodable { let id: String; let role: String }
    struct CueLine: Decodable {
        let index: Int
        let agentId: String?
        let start: Int
        let end: Int
        let value: String
        let cue: [Cue]
    }

    let id: Int
    let kind: String
    let lang: String
    let synced: Bool
    /// Positive shows the text sooner.
    let offset: Int
    let line: [Line]
    let agents: [Agent]?
    let cueLine: [CueLine]?
}

extension StructuredLyrics {
    var words: [Int: [Cue]] {
        Dictionary(uniqueKeysWithValues: (cueLine ?? []).map { ($0.index, $0.cue) })
    }

    /// Index of the line sung at `ms` of the track: the last one started, none before the first.
    func activeLine(atMs ms: Double) -> Int? {
        guard synced else { return nil }
        let t = ms + Double(offset)
        var found: Int?
        for (i, l) in line.enumerated() {
            guard let s = l.start else { continue }
            if Double(s) <= t { found = i } else { break }
        }
        return found
    }

    /// Time of the track a cue sits at, once the offset is taken out.
    func trackMs(_ lyricsMs: Int) -> Double { Double(lyricsMs - offset) }
}

enum LyricsAPI {
    /// The best entry of a track, nil when it has none.
    static func main(itemId: Int) async -> StructuredLyrics? {
        let res: LyricsResponse? = try? await APIClient.shared.get("/api/items/\(itemId)/lyrics", query: ["enhanced": "true"])
        return res?.structuredLyrics.first { $0.kind == "main" } ?? res?.structuredLyrics.first
    }
}
