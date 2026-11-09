import Foundation

/// One row of a CarPlay list: a folder to open (`folder`) or a track of the listing's queue (`track`).
struct CarRow {
    var folder: String?
    var track: Int?
    var title: String
    var subtitle: String?
    var artwork: String?
}

struct CarListing {
    var rows: [CarRow] = []
    /// The tracks the rows with a `track` index point into.
    var queue: [AudioPlayerPlugin.Entry] = []
}

/// The music of the fliks API as CarPlay lists; folder ids are `recent`, `favourites`, `playlists`, `albums`,
/// `artists`, `album:<id>`, `playlist:<id>` and `artist:<id>`.
@MainActor
struct CarPlayCatalog {
    let plugin: AudioPlayerPlugin
    let key: String

    private func json(_ path: String) async -> Any? {
        guard let (data, status) = await plugin.apiCall(key, "GET", path), (200..<300).contains(status) else { return nil }
        return try? JSONSerialization.jsonObject(with: data)
    }

    func listing(_ id: String) async -> CarListing? {
        switch id {
        case "recent":
            guard let rows = await json("/api/playback/recently-played?limit=60") as? [[String: Any]] else { return nil }
            return CarListing(rows: rows.compactMap(Self.album))
        case "favourites":
            guard let rows = await json("/api/tracks?favourite=true&sortBy=added&sortOrder=desc&limit=100") as? [[String: Any]] else { return nil }
            return Self.tracks(rows)
        case "playlists":
            guard let rows = await json("/api/playlists") as? [[String: Any]] else { return nil }
            return CarListing(rows: rows.compactMap { p in
                (p["id"] as? Int).map { CarRow(folder: "playlist:\($0)", title: p["name"] as? String ?? "", artwork: Self.text(p["coverImageUrl"])) }
            })
        case "albums":
            guard let rows = (await json("/api/media?type=album&sortBy=title&sortOrder=asc&limit=100") as? [String: Any])?["data"] as? [[String: Any]] else { return nil }
            return CarListing(rows: rows.compactMap(Self.album))
        case "artists":
            guard let rows = await json("/api/persons?role=artist&limit=100") as? [[String: Any]] else { return nil }
            return CarListing(rows: rows.compactMap { p in
                (p["id"] as? Int).map { CarRow(folder: "artist:\($0)", title: p["name"] as? String ?? "", artwork: Self.text(p["avatarUrl"])) }
            })
        default:
            break
        }
        if id.hasPrefix("artist:") {
            guard let albums = (await json("/api/persons/\(id.dropFirst(7))/discography") as? [String: Any])?["albums"] as? [[String: Any]] else { return nil }
            return CarListing(rows: albums.compactMap { a in
                guard a["owned"] as? Bool == true, let media = a["mediaId"] as? Int else { return nil }
                return CarRow(folder: "album:\(media)", title: a["title"] as? String ?? "", artwork: Self.text(a["posterUrl"]))
            })
        }
        if id.hasPrefix("album:") { return await albumTracks(String(id.dropFirst(6))) }
        if id.hasPrefix("playlist:") { return await playlistTracks(String(id.dropFirst(9))) }
        return nil
    }

    func search(_ query: String) async -> CarListing? {
        guard let q = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) else { return nil }
        async let albums = json("/api/media?type=album&limit=10&q=\(q)")
        async let tracks = json("/api/tracks?limit=30&q=\(q)")
        guard let found = await tracks as? [[String: Any]] else { return nil }
        var out = Self.tracks(found)
        let folders = ((await albums as? [String: Any])?["data"] as? [[String: Any]] ?? []).compactMap(Self.album)
        out.rows = folders + out.rows
        return out
    }

    private func albumTracks(_ id: String) async -> CarListing? {
        guard let media = await json("/api/media/\(id)") as? [String: Any], let album = media["album"] as? [String: Any],
              let tracks = album["tracks"] as? [[String: Any]] else { return nil }
        let editions = album["editions"] as? [[String: Any]] ?? []
        var edition = album["targetEditionId"] as? Int
        if edition == nil { edition = editions.first { $0["hasFiles"] as? Bool == true }?["id"] as? Int }
        let chosen = editions.first { $0["id"] as? Int == edition }
        let cover = Self.text(media["posterUrl"])
        var out = CarListing()
        for t in tracks where t["editionId"] as? Int == edition && t["hasFile"] as? Bool == true {
            var e = Self.entry(t, album: album)
            e.mediaId = media["id"] as? Int
            e.album = media["title"] as? String
            e.artwork = cover
            e.albumGain = Self.number(chosen?["albumGain"])
            e.albumPeak = Self.number(chosen?["albumPeak"])
            out.rows.append(CarRow(track: out.queue.count, title: e.title, subtitle: e.artist, artwork: cover))
            out.queue.append(e)
        }
        return out
    }

    private func playlistTracks(_ id: String) async -> CarListing? {
        guard let entries = await json("/api/playlists/\(id)/items") as? [[String: Any]] else { return nil }
        var out = CarListing()
        for row in entries {
            guard let t = row["track"] as? [String: Any], !(t["mediaFileId"] is NSNull), t["mediaFileId"] != nil else { continue }
            var e = Self.entry(t, album: nil)
            e.mediaId = t["mediaId"] as? Int
            e.album = t["albumTitle"] as? String
            e.artwork = Self.text(t["posterUrl"])
            out.rows.append(CarRow(track: out.queue.count, title: e.title, subtitle: e.artist, artwork: e.artwork))
            out.queue.append(e)
        }
        return out
    }

    private static func tracks(_ rows: [[String: Any]]) -> CarListing {
        var out = CarListing()
        for t in rows where t["hasFile"] as? Bool ?? true {
            var e = entry(t, album: nil)
            e.mediaId = t["mediaId"] as? Int
            e.album = t["albumTitle"] as? String
            e.artwork = text(t["posterUrl"])
            out.rows.append(CarRow(track: out.queue.count, title: e.title, subtitle: e.artist, artwork: e.artwork))
            out.queue.append(e)
        }
        return out
    }

    private static func album(_ m: [String: Any]) -> CarRow? {
        guard let id = m["id"] as? Int else { return nil }
        return CarRow(folder: "album:\(id)", title: m["title"] as? String ?? "",
                      subtitle: names((m["album"] as? [String: Any])?["artists"]), artwork: text(m["posterUrl"]))
    }

    private static func entry(_ t: [String: Any], album: [String: Any]?) -> AudioPlayerPlugin.Entry {
        var e = AudioPlayerPlugin.Entry()
        e.itemId = t["itemId"] as? Int
        e.title = t["title"] as? String ?? ""
        let own = names(t["artists"])
        e.artist = own.isEmpty ? names(album?["artists"]) : own
        e.gain = number(t["gain"])
        e.peak = number(t["peak"])
        return e
    }

    /// Credits come as objects (albums) or plain names (playlist tracks).
    private static func names(_ value: Any?) -> String {
        guard let list = value as? [Any] else { return "" }
        var out = ""
        for (i, a) in list.enumerated() {
            if let name = a as? String { out += name } else if let a = a as? [String: Any] {
                let credited = a["creditedName"] as? String ?? ""
                out += credited.isEmpty ? a["name"] as? String ?? "" : credited
                if i < list.count - 1, let join = a["joinPhrase"] as? String, !join.isEmpty { out += join; continue }
            }
            if i < list.count - 1 { out += ", " }
        }
        return out
    }

    private static func text(_ v: Any?) -> String? { v as? String }
    private static func number(_ v: Any?) -> Double? { (v as? NSNumber)?.doubleValue }
}
