import Foundation
import Capacitor
import UIKit
import WebKit

/// Left-edge back gesture for the WebView shell.
///
/// A Capacitor app is a single view controller, so iOS never offers its
/// interactive pop. The recognizer here runs at UIKit priority — the WebView's
/// scroll pan is made to wait on it, so a horizontal carousel sitting on the
/// edge can't steal the swipe — slides a snapshot of the current page off to
/// the right under the finger, and hands the commit to JS, which runs the
/// app's own back (same path as the Android hardware button).
///
/// The page underneath is a snapshot too: JS captures every page it leaves,
/// and this keeps them in a stack that mirrors the router's own back stack, so
/// the swipe reveals the page it is returning to rather than a flat colour.
///
/// Usage from JS:
///   BackGesture.setEnabled({ enabled: true })
///   BackGesture.captureCandidate()          // on NavigationStart
///   BackGesture.settle({ delta })           // on NavigationEnd
///   BackGesture.settled()                   // page done rebuilding
///   BackGesture.addListener('end', …)       // carries { commit }
@objc(BackGesturePlugin)
public class BackGesturePlugin: CAPPlugin, CAPBridgedPlugin, UIGestureRecognizerDelegate {
    public let identifier = "BackGesturePlugin"
    public let jsName = "BackGesture"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setEnabled", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "captureCandidate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "settle", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "settled", returnType: CAPPluginReturnPromise),
    ]

    /// Past this fraction of the screen the release commits, whatever the speed.
    private static let commitProgress: CGFloat = 0.3
    /// A flick commits below that fraction, in points per second.
    private static let commitVelocity: CGFloat = 500
    /// How far the page underneath trails the finger, as a fraction of the
    /// screen — the depth cue iOS uses on its own pop.
    private static let parallax: CGFloat = 0.28
    private static let dimAlpha: CGFloat = 0.32
    /// A full-screen snapshot costs ~10 MB, and two levels of parallax cover
    /// detail → library → home. Deeper returns fall back to the flat backdrop.
    private static let maxSnapshots = 3
    /// Matches the WebView background from capacitor.config.ts, so a return with
    /// no snapshot behind it reads as the app, not as a hole.
    private static let backdropColor = UIColor(red: 0.114, green: 0.137, blue: 0.161, alpha: 1)

    private weak var recognizer: UIScreenEdgePanGestureRecognizer?
    private var snapshot: UIView?
    private var previous: UIView?
    private var dim: UIView?
    private var backdrop: UIView?
    /// Set between .began and the async snapshot arriving; a gesture that ends
    /// in that window must not install the overlay afterwards.
    private var awaitingSnapshot = false
    /// Identifies the gesture a pending capture belongs to. Releasing before the
    /// image lands and starting again re-arms `awaitingSnapshot`, which the
    /// stale capture would otherwise take for its own — installing an overlay
    /// for a gesture already over, with nothing left to tear it down.
    private var gestureId = 0
    private var width: CGFloat = 1
    /// Set once the slide is over and the overlay is only waiting on the page.
    private var awaitingSettle = false
    /// Uncovers the WebView even if JS never reports, so a stalled navigation
    /// cannot leave the page hidden.
    private var settleFallback: DispatchWorkItem?
    /// Last resort: an overlay belongs to a live gesture or to the wait after a
    /// commit. Outside both, it is orphaned, and an orphan hides the whole app.
    private var watchdog: DispatchWorkItem?

    /// Pages left behind, oldest first: the last one is what a back returns to.
    /// Entries can be nil — a capture that failed, or one JS skipped — so the
    /// stack stays index-aligned with the router's and only loses its parallax.
    private var pageSnapshots: [UIImage?] = []
    /// Captured when a navigation starts, kept or dropped once the router says
    /// whether it grew the back stack.
    private var candidate: UIImage?
    /// Identifies the navigation a pending capture belongs to, so one that comes
    /// back after its own settle is dropped instead of being pushed for the next.
    private var captureId = 0

    override public func load() {
        DispatchQueue.main.async { [weak self] in self?.attach() }
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(dropSnapshots),
            name: UIApplication.didReceiveMemoryWarningNotification,
            object: nil
        )
        // A rotation resizes the container under an overlay whose layers are
        // laid out in points fixed at .began, and the hold after a commit can
        // still be running. Dropping it hands the page straight back.
        UIDevice.current.beginGeneratingDeviceOrientationNotifications()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(dropOverlay),
            name: UIDevice.orientationDidChangeNotification,
            object: nil
        )
    }

    @objc private func dropOverlay() {
        DispatchQueue.main.async { [weak self] in self?.teardown() }
    }

    private func attach() {
        guard let container = bridge?.viewController?.view else { return }
        let pan = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(handle(_:)))
        pan.edges = .left
        pan.delegate = self
        container.addGestureRecognizer(pan)
        // Without this the WebView scrolls under the finger while the snapshot
        // slides. Edge pans fail immediately away from the edge, so the wait
        // costs nothing anywhere else on screen.
        bridge?.webView?.scrollView.panGestureRecognizer.require(toFail: pan)
        recognizer = pan
    }

    @objc private func dropSnapshots() {
        pageSnapshots.removeAll()
        candidate = nil
    }

    /// Called by JS once the returning page has stopped rebuilding. A cached
    /// page comes back with its rows re-rendered, and the frames painted while
    /// that runs can be half-filled.
    @objc func settled(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if self.awaitingSettle { self.teardown() }
            call.resolve()
        }
    }

    @objc func setEnabled(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? true
        DispatchQueue.main.async { [weak self] in
            // No teardown here: the commit itself disarms the gesture (the page
            // reached has nowhere left to go back to), and tearing down on that
            // would uncover the WebView before the new page had painted. A
            // disabled recognizer cancels any live gesture, which finishes
            // through .cancelled and cleans up there.
            self?.recognizer?.isEnabled = enabled
            call.resolve()
        }
    }

    /// Snapshots the page a navigation is leaving. Resolves immediately: the
    /// capture is async and the caller has nothing to wait for.
    @objc func captureCandidate(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let webView = self.bridge?.webView else {
                call.resolve()
                return
            }
            // afterScreenUpdates would wait for the next render pass, and
            // mid-navigation that pass is the destination page: the shot came
            // back after settle had already given up on it.
            let config = WKSnapshotConfiguration()
            config.afterScreenUpdates = false
            // Resolved only once the image is stored, so JS can hold settle
            // back until the candidate exists.
            webView.takeSnapshot(with: config) { [weak self] image, _ in
                self?.candidate = image
                call.resolve()
            }
        }
    }

    /// `delta` is how much the router's back stack grew or shrank over the
    /// navigation. Mirroring it here rather than re-deriving which navigations
    /// count keeps one source of truth for what back returns to.
    @objc func settle(_ call: CAPPluginCall) {
        let delta = call.getInt("delta") ?? 0
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.resolve()
                return
            }
            if delta > 0 {
                self.pageSnapshots.append(self.candidate)
                while self.pageSnapshots.count > Self.maxSnapshots {
                    self.pageSnapshots.removeFirst()
                }
            }
            self.candidate = nil
            self.captureId &+= 1
            for _ in 0..<max(0, -delta) where !self.pageSnapshots.isEmpty {
                self.pageSnapshots.removeLast()
            }
            call.resolve()
        }
    }

    @objc private func handle(_ pan: UIScreenEdgePanGestureRecognizer) {
        guard let container = pan.view else { return }
        let translation = max(0, pan.translation(in: container).x)

        switch pan.state {
        case .began:
            gestureId &+= 1
            width = max(container.bounds.width, 1)
            captureSnapshot(for: gestureId)
        case .changed:
            apply(translation: translation)
        case .ended, .cancelled, .failed:
            let velocity = pan.velocity(in: container).x
            let commit = pan.state == .ended
                && (translation / width > Self.commitProgress || velocity > Self.commitVelocity)
            finish(commit: commit, from: translation, velocity: velocity)
        default:
            break
        }
    }

    /// takeSnapshot rather than snapshotView: WebKit renders out of process, and
    /// the UIView-level copy comes back blank often enough to matter.
    private func captureSnapshot(for id: Int) {
        guard let webView = bridge?.webView, let container = bridge?.viewController?.view else { return }
        let config = WKSnapshotConfiguration()
        config.afterScreenUpdates = false
        awaitingSnapshot = true
        webView.takeSnapshot(with: config) { [weak self] image, _ in
            guard let self, id == self.gestureId, self.awaitingSnapshot, let image else { return }
            self.awaitingSnapshot = false
            // The finger may have lifted while the image was being taken.
            let state = self.recognizer?.state
            guard state == .began || state == .changed else { return }
            self.install(image: image, over: webView, in: container)
        }
    }

    private func install(image: UIImage, over webView: WKWebView, in container: UIView) {
        // Nothing of a previous gesture survives into this one.
        teardown()
        let frame = container.convert(webView.bounds, from: webView)

        let backdrop = UIView(frame: container.bounds)
        backdrop.backgroundColor = Self.backdropColor
        backdrop.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        // The hold can outlast the slide; a tap then belongs to the page
        // underneath, which is already the one on display.
        backdrop.isUserInteractionEnabled = false
        container.addSubview(backdrop)
        self.backdrop = backdrop

        // A snapshot taken in the other orientation would be stretched into
        // this frame. The stack keeps it — rotating back makes it usable again
        // — and this return simply falls back to the flat backdrop.
        if let behind = pageSnapshots.last ?? nil, matches(behind, frame) {
            let view = UIImageView(image: behind)
            view.frame = frame
            container.addSubview(view)
            previous = view

            let shade = UIView(frame: view.bounds)
            shade.backgroundColor = .black
            shade.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            view.addSubview(shade)
            dim = shade
        }

        let view = UIImageView(image: image)
        view.frame = frame
        view.layer.shadowColor = UIColor.black.cgColor
        view.layer.shadowOpacity = 0.4
        view.layer.shadowRadius = 12
        view.layer.shadowOffset = CGSize(width: -4, height: 0)
        container.addSubview(view)
        snapshot = view
        armWatchdog()

        // The finger has moved during the capture; catch up in one step.
        let live = recognizer?.state == .changed || recognizer?.state == .began
        apply(translation: live ? max(0, recognizer?.translation(in: container).x ?? 0) : 0)
    }

    private func armWatchdog() {
        watchdog?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.backdrop != nil, !self.awaitingSettle else { return }
            let state = self.recognizer?.state
            guard state != .began && state != .changed else {
                self.armWatchdog()
                return
            }
            self.teardown()
        }
        watchdog = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2, execute: work)
    }

    /// Same shape, within the rounding a snapshot's pixel size introduces.
    private func matches(_ image: UIImage, _ frame: CGRect) -> Bool {
        guard image.size.height > 0, frame.height > 0 else { return false }
        let ratio = (image.size.width / image.size.height) / (frame.width / frame.height)
        return abs(ratio - 1) < 0.02
    }

    private func apply(translation: CGFloat) {
        let progress = min(max(translation / width, 0), 1)
        snapshot?.transform = CGAffineTransform(translationX: translation, y: 0)
        previous?.transform = CGAffineTransform(translationX: -Self.parallax * width * (1 - progress), y: 0)
        dim?.alpha = Self.dimAlpha * (1 - progress)
    }

    private func finish(commit: Bool, from translation: CGFloat, velocity: CGFloat) {
        awaitingSnapshot = false
        notifyListeners("end", data: ["commit": commit])

        guard snapshot != nil else {
            teardown()
            return
        }

        let target = commit ? width : 0
        let distance = abs(target - translation)
        // Track the flick's speed, within the bounds iOS uses for its own pop.
        let duration = min(0.4, max(0.12, Double(distance / max(abs(velocity), 400))))
        UIView.animate(withDuration: duration, delay: 0, options: [.curveEaseOut, .beginFromCurrentState]) {
            self.apply(translation: target)
        } completion: { [weak self] _ in
            guard let self else { return }
            guard commit else {
                self.teardown()
                return
            }
            // What stays on screen is the snapshot of the page being returned
            // to, so waiting on it shows the viewer nothing but the destination.
            self.snapshot?.removeFromSuperview()
            self.snapshot = nil
            self.awaitingSettle = true
            let fallback = DispatchWorkItem { [weak self] in self?.teardown() }
            self.settleFallback = fallback
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.9, execute: fallback)
        }
    }

    private func teardown() {
        watchdog?.cancel()
        watchdog = nil
        awaitingSettle = false
        settleFallback?.cancel()
        settleFallback = nil
        snapshot?.removeFromSuperview()
        snapshot = nil
        previous?.removeFromSuperview()
        previous = nil
        dim = nil
        backdrop?.removeFromSuperview()
        backdrop = nil
        awaitingSnapshot = false
    }

    // The gesture owns the touch outright: nothing in the page scrolls while
    // the page itself is sliding away.
    public func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
    ) -> Bool {
        return false
    }
}
