import SwiftUI

/// Shared ambient backdrop — a blurred, darkened fanart behind the whole
/// signed-in shell. Holds a raw (unresolved) API image path; `BackdropView`
/// resolves it once, at `.full` size.
@Observable final class Backdrop {
    var url: String?
}

extension Backdrop {
    /// First zone to load wins the ambient backdrop; later zones no-op here —
    /// focusing one of their own cards (`MediaCard`) takes over from then on.
    func seed(_ path: String?) {
        guard url == nil, let path else { return }
        url = path
    }
}

struct BackdropView: View {
    let backdrop: Backdrop

    var body: some View {
        ZStack {
            Color.black
            if backdrop.url != nil {
                CachedAsyncImage(url: ImageURL.build(backdrop.url, size: .full)) { Color.clear }
                    // Clamp + clip so a changing image never resizes the root layout.
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .clipped()
                    .blur(radius: 60)
                    .opacity(0.35)
            }
            LinearGradient(colors: [.black.opacity(0.3), .black.opacity(0.85)],
                           startPoint: .top, endPoint: .bottom)
        }
        .ignoresSafeArea()
        .animation(.easeInOut(duration: 0.6), value: backdrop.url)
    }
}
