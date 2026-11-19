import SwiftUI

/// The toast of `NotificationToastService`: no buttons, never focusable, so spatial focus is untouched.
struct NotificationToastView: View {
    let service: NotificationToastService

    var body: some View {
        Group {
            if let note = service.current {
                HStack(spacing: 20) {
                    if let image = ImageURL.build(note.image, size: .thumb) {
                        CachedAsyncImage(url: image) { Color.white.opacity(0.1) }
                            .frame(width: 72, height: 108)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
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
        .allowsHitTesting(false)
        .focusable(false)
    }
}
