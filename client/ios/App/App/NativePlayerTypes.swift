import AVFoundation
import UIKit

/// Letterbox crop of the video, in source pixels.
struct VideoCrop: Equatable {
    var x: CGFloat
    var y: CGFloat
    var width: CGFloat
    var height: CGFloat
    var sourceWidth: CGFloat
    var sourceHeight: CGFloat
}

/// Mirrors `computeVideoCropStyle` (player.utils.ts): the AVPlayerLayer frame
/// that maps the crop rect onto the container, aspect-fit or aspect-fill.
enum VideoCropLayout {
    /// `display` is the presented size (anamorphic-corrected); nil falls back to the source size.
    static func layerFrame(container: CGSize, crop: VideoCrop?, display: CGSize?, fill: Bool) -> CGRect? {
        guard let crop = crop,
              container.width > 0, container.height > 0,
              crop.sourceWidth > 0, crop.sourceHeight > 0,
              crop.width > 0, crop.height > 0 else { return nil }
        if crop.width >= crop.sourceWidth && crop.height >= crop.sourceHeight { return nil }
        var dw = crop.sourceWidth
        var dh = crop.sourceHeight
        if let d = display, d.width > 0, d.height > 0 {
            dw = d.width
            dh = d.height
        }
        let sx = dw / crop.sourceWidth
        let sy = dh / crop.sourceHeight
        let cropW = crop.width * sx
        let cropH = crop.height * sy
        let scaleX = container.width / cropW
        let scaleY = container.height / cropH
        let scale = fill ? max(scaleX, scaleY) : min(scaleX, scaleY)
        return CGRect(
            x: (container.width - cropW * scale) / 2 - crop.x * sx * scale,
            y: (container.height - cropH * scale) / 2 - crop.y * sy * scale,
            width: dw * scale,
            height: dh * scale
        )
    }
}

/// Clips the AVPlayerLayer, which the plugin may size beyond bounds to crop the video.
class PlayerContainerView: UIView {
    var onLayout: (() -> Void)?

    override func layoutSubviews() {
        super.layoutSubviews()
        onLayout?()
    }
}

/// Running decoded-frame estimate: each sample adds the newly watched seconds at the current rate,
/// so a frame-rate change never rescales the history. Restarts with a new AVPlayerItem.
struct DecodedEstimate {
    private var item: ObjectIdentifier?
    private var watched = 0.0
    private var decoded = 0.0

    mutating func update(item new: AVPlayerItem?, watched total: Double, fps: Double?) -> Int? {
        let id = new.map(ObjectIdentifier.init)
        if id != item { self = DecodedEstimate(item: id) }
        decoded += max(total - watched, 0) * (fps ?? 0)
        watched = total
        return decoded > 0 ? Int(decoded.rounded()) : nil
    }
}

/// Repeats the JS position heartbeat while the app is not active: the WebView is suspended then (PiP, lock
/// screen, background audio), taking the JS timer and the bridge with it. Main thread only.
final class PositionHeartbeat {
    private static let interval: TimeInterval = 10
    private var url: URL?
    private var token = ""
    private var body: [String: Any] = [:]
    private var lastSent = Date.distantPast

    /// `body` is the last JS heartbeat; it carries the session and file ids the server needs.
    func set(url: String, token: String, body: [String: Any]) {
        self.url = URL(string: url)
        self.token = token
        self.body = body
    }

    /// False when the receiver plays another file than the one `body` names: its clock is not that file's.
    func ownsFile(_ customData: Any?) -> Bool {
        let playing = (customData as? [String: Any])?["mediaFileId"] as? NSNumber
        return playing != nil && playing == body["mediaFileId"] as? NSNumber
    }

    func clear() {
        url = nil
        body = [:]
    }

    /// `state` is sent only with a session: without one the server takes the beat as a plain position save.
    func send(position: Double, duration: Double, state: String) {
        guard let url = url, position.isFinite,
              UIApplication.shared.applicationState != .active,
              Date().timeIntervalSince(lastSent) >= Self.interval else { return }
        var payload = body
        payload["positionSeconds"] = position
        if duration.isFinite, duration > 0 { payload["durationSeconds"] = duration }
        if payload["sessionId"] != nil { payload["state"] = state }
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        lastSent = Date()
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = data
        URLSession.shared.dataTask(with: request).resume()
    }
}
