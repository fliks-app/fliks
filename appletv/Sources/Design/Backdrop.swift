import SwiftUI
import UIKit

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
        // Same stack as the web client's page background: the fanart unblurred
        // under a 95% base-100 veil (`--bg-veil`), then the brand tint.
        let base = Color(red: 29 / 255, green: 35 / 255, blue: 42 / 255)
        ZStack {
            base
            // Clamp so a changing image never resizes the root layout.
            CrossfadeImage(url: ImageURL.build(backdrop.url, size: .full))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            base.opacity(0.95)
            Color.fliks("primary").opacity(0.15)
        }
        .ignoresSafeArea()
    }
}

extension View {
    /// The shell's ambient backdrop behind a pushed page: a navigation push paints
    /// the system background otherwise.
    func shellBackdrop() -> some View { modifier(ShellBackdrop()) }
}

private struct ShellBackdrop: ViewModifier {
    @Environment(Backdrop.self) private var backdrop

    func body(content: Content) -> some View {
        content.background { BackdropView(backdrop: backdrop).ignoresSafeArea() }
    }
}

/// Image that dissolves between sources: the one on screen stays fully opaque
/// while the next loads, then the next fades in on top of it and takes its
/// place. Two layers rather than one fading view — a single view dropping to
/// `nil` between sources would expose the black root, and a symmetric
/// cross-dissolve would dim at the halfway point.
private struct CrossfadeImage: View {
    let url: String?
    var blurRadius: CGFloat = 0
    var duration: Double = 0.6
    /// Moving focus across a rail fires one URL per card. Waiting a beat means
    /// only the card actually settled on starts a fade, instead of a burst of
    /// fades cutting each other off.
    var settleDelay: Duration = .milliseconds(220)

    @State private var base: UIImage?
    @State private var incoming: UIImage?
    @State private var incomingOpacity: Double = 0
    /// Bumped by every transition so a completion that belongs to a superseded
    /// one can't promote its image.
    @State private var generation = 0

    var body: some View {
        GeometryReader { geo in
            ZStack {
                if let base { layer(base, size: geo.size) }
                if let incoming { layer(incoming, size: geo.size).opacity(incomingOpacity) }
            }
        }
        .task(id: url) {
            try? await Task.sleep(for: settleDelay)
            guard !Task.isCancelled else { return }
            await load()
        }
    }

    /// Pinned to the container size: a layer left to size itself would grow or
    /// shrink the stack when a portrait poster follows a landscape fanart.
    /// Blurred `opaque` then re-clipped — a blur reads past the edges and would
    /// otherwise wash out the sides.
    private func layer(_ image: UIImage, size: CGSize) -> some View {
        Image(uiImage: image)
            .resizable()
            .scaledToFill()
            .frame(width: size.width, height: size.height)
            .clipped()
            .blur(radius: blurRadius, opaque: true)
            .frame(width: size.width, height: size.height)
            .clipped()
    }

    private func load() async {
        guard let url, let parsed = URL(string: url) else {
            generation += 1
            withAnimation(.easeInOut(duration: duration)) {
                base = nil
                incoming = nil
                incomingOpacity = 0
            }
            return
        }
        // Synchronous hit first: a warm image starts its fade in this frame.
        if let hit = ImageCache.memory.object(forKey: parsed as NSURL) { fade(to: hit); return }
        guard let image = await ImageCache.load(parsed), !Task.isCancelled else { return }
        fade(to: image)
    }

    private func fade(to image: UIImage) {
        // What the screen is heading towards, which is the incoming layer while
        // one is in flight — not the base under it.
        guard (incoming ?? base) !== image else { return }
        generation += 1
        let token = generation

        // Going back to the image already underneath (focus returning to the
        // card it just left): unwind the fade instead of stacking another one.
        if base === image, incoming != nil {
            withAnimation(.easeInOut(duration: duration)) {
                incomingOpacity = 0
            } completion: {
                guard token == generation else { return }
                incoming = nil
                incomingOpacity = 0
            }
            return
        }

        // A fade cut short keeps its image as the new base. Swapping the
        // picture inside the half-faded layer instead would read as a hard cut.
        if let inFlight = incoming {
            base = inFlight
            incoming = nil
            incomingOpacity = 0
        }
        incoming = image
        withAnimation(.easeInOut(duration: duration)) {
            incomingOpacity = 1
        } completion: {
            guard token == generation else { return }
            base = image
            incoming = nil
            incomingOpacity = 0
        }
    }
}
