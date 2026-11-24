import Foundation

enum ImageSize: String {
    case thumb, medium, full
}

/// Turns an API image path (e.g. `/api/images/media/42/poster`, as stored on
/// `Media.posterUrl`) into a full URL against the active server, with a `?size=`
/// hint. A provider URL goes through the server's artwork proxy when the server
/// has it (server `images.md` section E). The image routes need no auth token.
enum ImageURL {
    @MainActor static func build(_ path: String?, size: ImageSize = .medium) -> String? {
        guard let path, !path.isEmpty else { return nil }
        if path.hasPrefix("http://") || path.hasPrefix("https://"), ServerVersion.shared.supports("7.2.0"),
           let url = path.addingPercentEncoding(withAllowedCharacters: .urlUnreserved) {
            return ServerStore.shared.resolveUrl("/api/images/remote?url=\(url)&size=\(size.rawValue)")
        }
        let resolved = ServerStore.shared.resolveUrl(path)
        guard var comps = URLComponents(string: resolved) else { return resolved }
        var items = (comps.queryItems ?? []).filter { $0.name != "size" }
        items.append(URLQueryItem(name: "size", value: size.rawValue))
        comps.queryItems = items
        return comps.url?.absoluteString ?? resolved
    }
}

private extension CharacterSet {
    static let urlUnreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
}
