import SwiftUI

/// The toast of `NotificationToastService`: no buttons, never focusable, so spatial focus is untouched.
struct NotificationToastView: View {
    let service: NotificationToastService

    var body: some View {
        Group {
            if let note = service.current {
                HStack(spacing: 0) {
                    NotificationImage(path: note.image)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(note.title).font(.headline).lineLimit(1)
                        if !note.body.isEmpty { Text(note.body).font(.callout).foregroundStyle(.secondary).lineLimit(2) }
                    }
                }
                .padding(20)
                .frame(maxWidth: 900, alignment: .leading)
                .background(.black.opacity(0.8), in: RoundedRectangle(cornerRadius: 16))
                .padding(.top, 40)
                .transition(.move(edge: .top).combined(with: .opacity))
                .accessibilityElement(children: .combine)
            }
        }
        .animation(.easeInOut(duration: 0.25), value: service.current)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .allowsHitTesting(false)
        .focusable(false)
    }
}

/// The notification image, shown only once loaded; an avatar is round, anything else a poster.
private struct NotificationImage: View {
    let path: String?
    @State private var image: UIImage?

    private var isAvatar: Bool { path?.contains("/api/images/user/") == true }

    var body: some View {
        // The zero-size anchor keeps `.task` alive while there is no image.
        ZStack {
            Color.clear.frame(width: 0, height: 0)
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
                    .frame(width: 72, height: isAvatar ? 72 : 108)
                    .clipShape(RoundedRectangle(cornerRadius: isAvatar ? 36 : 8))
                    .padding(.trailing, 20)
            }
        }
        .task(id: path) {
            image = nil
            if let url = ImageURL.build(path, size: .thumb).flatMap(URL.init(string:)) { image = await ImageCache.load(url) }
        }
    }
}

/// A passthrough window above every presentation (party covers, sheets) that hosts the toast.
@MainActor
final class ToastWindow {
    static let shared = ToastWindow()
    private var window: UIWindow?

    private final class Passthrough: UIWindow {
        override var canBecomeKey: Bool { false }
        override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? { nil }
    }

    func install(service: NotificationToastService) {
        guard window == nil,
              let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else { return }
        let host = UIHostingController(rootView: NotificationToastView(service: service))
        host.view.backgroundColor = .clear
        let window = Passthrough(windowScene: scene)
        window.windowLevel = .alert
        window.rootViewController = host
        window.isHidden = false
        self.window = window
    }
}
