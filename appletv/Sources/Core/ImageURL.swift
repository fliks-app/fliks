import Foundation

enum ImageSize: String {
    case thumb, medium, full
}

/// Turns a relative API image path (e.g. `/api/images/media/42/poster`, as
/// stored on `Media.posterUrl`) into a full URL against the active server,
/// with a `?size=` hint. Absolute URLs pass through unchanged. No auth token
/// needed — `ImageController` on the backend is unguarded.
enum ImageURL {
    static func build(_ path: String?, size: ImageSize = .medium) -> String? {
        guard let path, !path.isEmpty else { return nil }
        let resolved = ServerStore.shared.resolveUrl(path)
        guard var comps = URLComponents(string: resolved) else { return resolved }
        var items = comps.queryItems ?? []
        items.append(URLQueryItem(name: "size", value: size.rawValue))
        comps.queryItems = items
        return comps.url?.absoluteString ?? resolved
    }
}
