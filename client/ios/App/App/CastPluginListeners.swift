import Foundation
import UIKit
import Capacitor
import GoogleCast

extension CastPlugin {
    // MARK: - Session Manager Listener

    public func sessionManager(_ sessionManager: GCKSessionManager, didStart session: GCKCastSession) {
        sessionStarting = false
        onConnected(session)
    }

    public func sessionManager(_ sessionManager: GCKSessionManager, willStart session: GCKCastSession) {
        sessionStarting = true
    }

    public func sessionManager(_ sessionManager: GCKSessionManager, didResumeCastSession session: GCKCastSession) {
        onConnected(session)
    }

    public func sessionManager(_ sessionManager: GCKSessionManager, didEnd session: GCKSession, withError error: (any Error)?) {
        if live { UserDefaults.standard.removeObject(forKey: Self.resumeKey) }
        live = false
        pendingResume = nil
        detachFliksChannel()
        stopPolling()
        emitCastState(connected: false)
    }

    public func sessionManager(_ sessionManager: GCKSessionManager, didFailToStart session: GCKSession, withError error: any Error) {
        stopPolling()
        emitCastState(connected: false)
        emitPickerDismissed()
    }

    func detachFliksChannel() {
        if let channel = fliksChannel { fliksChannelSession?.remove(channel) }
        fliksChannel = nil
        fliksChannelSession = nil
    }

    func attachFliksChannel(_ session: GCKCastSession) {
        if fliksChannelSession === session { return }
        detachFliksChannel()
        let channel = GCKGenericChannel(namespace: Self.fliksNamespace)
        channel.delegate = self
        session.add(channel)
        fliksChannel = channel
        fliksChannelSession = session
    }

    public func cast(_ channel: GCKGenericChannel, didReceiveTextMessage message: String, withNamespace protocolNamespace: String) {
        let detail: [String: Any] = ["namespace": protocolNamespace, "message": message]
        guard let data = try? JSONSerialization.data(withJSONObject: detail),
              let json = String(data: data, encoding: .utf8) else { return }
        let js = "window.dispatchEvent(new CustomEvent('castReceiverMessage', { detail: \(json) }));"
        DispatchQueue.main.async { [weak self] in
            self?.bridge?.webView?.evaluateJavaScript(js)
        }
    }

    // MARK: - Discovery Manager Listener

    public func didUpdateDeviceList() {
        let dm = GCKCastContext.sharedInstance().discoveryManager
        print("[CastPlugin] didUpdateDeviceList: deviceCount=\(dm.deviceCount)")
        for i in 0..<dm.deviceCount {
            let device = dm.device(at: i)
            print("[CastPlugin]   device[\(i)]: \(device.friendlyName ?? "?") @ \(device.networkAddress.ipAddress ?? "?")")
        }
        emitAvailability(dm.deviceCount > 0)
    }

    /// Also fires castDevicesChanged: every caller of this reflects a device-list update,
    /// and didUpdateDeviceList is the only discovery hook we want wired.
    func emitAvailability(_ available: Bool) {
        let js = "window.dispatchEvent(new CustomEvent('castAvailabilityChanged', { detail: { available: \(available) } }));"
            + "window.dispatchEvent(new CustomEvent('castDevicesChanged'));"
        DispatchQueue.main.async { [weak self] in
            self?.bridge?.webView?.evaluateJavaScript(js)
        }
    }

    // MARK: - Polling

    func startPolling() {
        stopPolling()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            DispatchQueue.main.async {
                self?.pollMediaState()
            }
        }
    }

    func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    @objc func appDidEnterBackground() {
        pollWasActiveBeforeBackground = pollTimer != nil
        stopPolling()
    }

    @objc func appWillEnterForeground() {
        if pollWasActiveBeforeBackground && currentSession?.remoteMediaClient != nil {
            startPolling()
        }
        pollWasActiveBeforeBackground = false
    }

    func pollMediaState() {
        guard let client = currentSession?.remoteMediaClient,
              let status = client.mediaStatus else { return }

        let time = client.approximateStreamPosition()
        let duration = status.mediaInformation?.streamDuration ?? 0
        let paused = status.playerState == .paused
        // Device (receiver) volume lives on the session, not media status —
        // read it each tick so external changes mirror back into the slider.
        let volume = currentSession?.currentDeviceVolume ?? 1
        let muted = currentSession?.currentDeviceMuted ?? false

        let ended = status.playerState == .idle && status.idleReason == .finished
        emitMediaUpdate(time: time, duration: duration, paused: paused, volume: volume, muted: muted, ended: ended)
    }

    // MARK: - Helpers

    var currentSession: GCKCastSession? {
        return sessionManager?.currentCastSession
    }

    func emitCastState(connected: Bool) {
        let js = "window.dispatchEvent(new CustomEvent('castStateChanged', { detail: { connected: \(connected) } }));"
        DispatchQueue.main.async { [weak self] in
            self?.bridge?.webView?.evaluateJavaScript(js)
        }
    }

    func emitPickerDismissed() {
        let js = "window.dispatchEvent(new CustomEvent('castPickerDismissed'));"
        DispatchQueue.main.async { [weak self] in
            self?.bridge?.webView?.evaluateJavaScript(js)
        }
    }

    func emitMediaUpdate(time: TimeInterval, duration: TimeInterval, paused: Bool, volume: Float, muted: Bool, ended: Bool) {
        let js = "window.dispatchEvent(new CustomEvent('castMediaUpdate', { detail: { currentTime: \(time), duration: \(duration), isPaused: \(paused), volume: \(volume), muted: \(muted), ended: \(ended) } }));"
        DispatchQueue.main.async { [weak self] in
            self?.bridge?.webView?.evaluateJavaScript(js)
        }
    }

    /// Maps the sender's subtitle presets (`size`, `color`, `shadow`, `background`, same vocabulary as the local player)
    /// onto `GCKMediaTextTrackStyle`; nil spec gives the receiver's defaults.
    func buildTextTrackStyle(_ spec: [String: Any]?) -> GCKMediaTextTrackStyle {
        let style = GCKMediaTextTrackStyle.createDefault()
        style.fontGenericFamily = .sansSerif
        let size = spec?["size"] as? String ?? "normal"
        let color = spec?["color"] as? String ?? "white"
        let shadow = spec?["shadow"] as? String ?? "drop"
        let bg = spec?["background"] as? String ?? "transparent"
        style.fontScale = mapSize(size)
        style.foregroundColor = mapFgColor(color)
        style.backgroundColor = mapBgColor(bg)
        let edge = mapShadow(shadow)
        style.edgeType = edge.type
        style.edgeColor = edge.color
        return style
    }

    /// Mirrors CAST_SUBTITLE_SIZE_SCALE (subtitle-presets.ts).
    func mapSize(_ name: String) -> CGFloat {
        switch name {
        case "xsmall": return 0.7
        case "small": return 0.775
        case "large": return 0.975
        case "xlarge": return 1.1
        default: return 0.85
        }
    }

    func mapFgColor(_ name: String) -> GCKColor {
        switch name {
        case "yellow": return GCKColor(uiColor: UIColor(red: 1, green: 1, blue: 0, alpha: 1))
        case "green": return GCKColor(uiColor: UIColor(red: 0, green: 1, blue: 0, alpha: 1))
        case "cyan": return GCKColor(uiColor: UIColor(red: 0, green: 1, blue: 1, alpha: 1))
        default: return GCKColor(uiColor: .white)
        }
    }

    func mapBgColor(_ name: String) -> GCKColor {
        switch name {
        case "semi": return GCKColor(uiColor: UIColor(red: 0, green: 0, blue: 0, alpha: 0.5))
        case "black": return GCKColor(uiColor: .black)
        default: return GCKColor(uiColor: .clear)
        }
    }

    func mapShadow(_ name: String) -> (type: GCKMediaTextTrackStyleEdgeType, color: GCKColor) {
        switch name {
        case "none": return (.none, GCKColor(uiColor: .clear))
        case "outline": return (.outline, GCKColor(uiColor: .black))
        case "raised": return (.raised, GCKColor(uiColor: .black))
        default: return (.dropShadow, GCKColor(uiColor: .black))
        }
    }
}
