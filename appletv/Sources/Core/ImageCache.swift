import SwiftUI
import UIKit

/// Bounded, auto-evicting cache of decoded images (skips re-decode when a
/// card scrolls back into view), backed by a bumped `URLCache` (skips
/// re-download of the bytes). tvOS memory is tight — sizes stay modest.
enum ImageCache {
    static let memory: NSCache<NSURL, UIImage> = {
        let cache = NSCache<NSURL, UIImage>()
        cache.countLimit = 200
        cache.totalCostLimit = 80 * 1024 * 1024 // ~80 MB of decoded images
        return cache
    }()

    /// Call once at launch — `URLSession.shared` (used by the loader) reads `URLCache.shared`.
    static func configure() {
        URLCache.shared = URLCache(memoryCapacity: 32 * 1024 * 1024,
                                   diskCapacity: 200 * 1024 * 1024)
    }

    static func clear() {
        memory.removeAllObjects()
        URLCache.shared.removeAllCachedResponses()
    }

    /// Decoded image for a URL — memory cache when warm, otherwise fetched and cached.
    static func load(_ url: URL) async -> UIImage? {
        if let hit = memory.object(forKey: url as NSURL) { return hit }
        guard let (data, _) = try? await URLSession.shared.data(from: url),
              let img = UIImage(data: data) else { return nil }
        memory.setObject(img, forKey: url as NSURL, cost: data.count)
        return img
    }

    /// Warm the cache for URLs not yet loaded (e.g. an upcoming rail's posters).
    /// Runs at low priority off the main thread.
    static func prefetch(_ urls: [String]) {
        for str in urls {
            guard let u = URL(string: str), memory.object(forKey: u as NSURL) == nil else { continue }
            Task.detached(priority: .utility) { _ = await load(u) }
        }
    }
}

/// Drop-in async image using the shared cache. Renders the decoded image
/// (`scaledToFill`) on success, `placeholder` otherwise. A cache hit shows
/// instantly (no flash) — the win when scrolling rails/grids.
struct CachedAsyncImage<Placeholder: View>: View {
    let url: String?
    var contentMode: ContentMode = .fill
    let placeholder: () -> Placeholder
    @State private var image: UIImage?

    init(url: String?, contentMode: ContentMode = .fill, @ViewBuilder placeholder: @escaping () -> Placeholder) {
        self.url = url
        self.contentMode = contentMode
        self.placeholder = placeholder
    }

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().aspectRatio(contentMode: contentMode)
            } else {
                placeholder()
            }
        }
        .task(id: url) { await load() }
    }

    private func load() async {
        guard let str = url, let u = URL(string: str) else { image = nil; return }
        if let hit = ImageCache.memory.object(forKey: u as NSURL) { image = hit; return }
        image = nil
        image = await ImageCache.load(u)
    }
}
