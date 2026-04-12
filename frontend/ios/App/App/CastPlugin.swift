import Foundation
import Capacitor
import GoogleCast

@objc(CastPlugin)
public class CastPlugin: CAPPlugin, CAPBridgedPlugin, GCKSessionManagerListener, GCKRemoteMediaClientListener, GCKDiscoveryManagerListener {
    public let identifier = "CastPlugin"
    public let jsName = "NativeCast"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "initialize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isConnected", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "loadMedia", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seek", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setActiveSubtitle", returnType: CAPPluginReturnPromise),
    ]

    private var sessionManager: GCKSessionManager?
    private var pollTimer: Timer?

    // MARK: - Initialize

    @objc func initialize(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }

            // GCKCastContext already initialized in AppDelegate
            self.sessionManager = GCKCastContext.sharedInstance().sessionManager
            self.sessionManager?.add(self)

            // Listen for device discovery
            let discoveryManager = GCKCastContext.sharedInstance().discoveryManager
            discoveryManager.add(self)

            let hasDevices = discoveryManager.deviceCount > 0
            print("[CastPlugin] initialize: discoveryState=\(discoveryManager.discoveryState.rawValue), deviceCount=\(discoveryManager.deviceCount), hasDevices=\(hasDevices)")

            // Resolve immediately with current state
            call.resolve(["available": hasDevices])

            // Discovery results often arrive after initialize — poll briefly
            if !hasDevices {
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                    let count = GCKCastContext.sharedInstance().discoveryManager.deviceCount
                    print("[CastPlugin] deferred check: deviceCount=\(count)")
                    if count > 0 {
                        self?.emitAvailability(true)
                    }
                }
            }
        }
    }

    // MARK: - Connection

    @objc func isConnected(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            let connected = self?.currentSession?.remoteMediaClient != nil
            call.resolve(["connected": connected])
        }
    }

    private var sessionStarting = false

    @objc func requestSession(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.sessionStarting = false

            GCKCastContext.sharedInstance().presentCastDialog()
            call.resolve()

            // Poll to detect when the dialog is dismissed
            // The Cast dialog is presented as a modal — when it's gone and no session started, emit dismissed
            self.pollForDialogDismiss()
        }
    }

    private func pollForDialogDismiss() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self = self else { return }

            // Check if a modal is still presented (Cast dialog)
            if let vc = self.bridge?.viewController, vc.presentedViewController != nil {
                // Dialog still open, keep polling
                self.pollForDialogDismiss()
            } else {
                // Dialog closed — if no session started, notify JS
                if self.currentSession?.connectionState != .connected && !self.sessionStarting {
                    self.emitPickerDismissed()
                }
            }
        }
    }

    @objc func disconnect(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.sessionManager?.endSessionAndStopCasting(true)
            self?.stopPolling()
            call.resolve()
        }
    }

    // MARK: - Media

    @objc func loadMedia(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let client = self?.currentSession?.remoteMediaClient else {
                call.reject("Not connected to Cast device")
                return
            }

            let url = call.getString("url") ?? ""
            let contentType = call.getString("contentType") ?? "application/x-mpegurl"
            let title = call.getString("title") ?? ""
            let subtitle = call.getString("subtitle") ?? ""
            let posterUrl = call.getString("posterUrl") ?? ""
            let currentTime = call.getDouble("currentTime") ?? 0

            let metadata = GCKMediaMetadata(metadataType: .movie)
            metadata.setString(title, forKey: kGCKMetadataKeyTitle)
            metadata.setString(subtitle, forKey: kGCKMetadataKeySubtitle)
            if !posterUrl.isEmpty, let imageUrl = URL(string: posterUrl) {
                metadata.addImage(GCKImage(url: imageUrl, width: 480, height: 720))
            }

            let builder = GCKMediaInformationBuilder(contentURL: URL(string: url)!)
            builder.streamType = .buffered
            builder.contentType = contentType
            builder.metadata = metadata

            // Subtitles
            var tracks: [GCKMediaTrack] = []
            var activeTrackId: Int? = call.getInt("activeSubtitleTrackId")

            if let subsArray = call.getArray("subtitles") as? [[String: Any]] {
                for (index, sub) in subsArray.enumerated() {
                    let trackId = index + 1
                    let subUrl = sub["url"] as? String ?? ""
                    let label = sub["label"] as? String ?? ""
                    let language = sub["language"] as? String ?? "und"

                    if let track = GCKMediaTrack(
                        identifier: trackId,
                        contentIdentifier: subUrl,
                        contentType: "text/vtt",
                        type: .text,
                        textSubtype: .subtitles,
                        name: label,
                        languageCode: language,
                        customData: nil
                    ) {
                        tracks.append(track)
                    }
                }
            }

            if !tracks.isEmpty {
                builder.mediaTracks = tracks

                let textStyle = GCKMediaTextTrackStyle.createDefault()
                textStyle.fontScale = 0.85
                textStyle.fontGenericFamily = .sansSerif
                textStyle.foregroundColor = GCKColor(uiColor: .white)
                textStyle.backgroundColor = GCKColor(uiColor: .clear)
                textStyle.edgeType = .dropShadow
                textStyle.edgeColor = GCKColor(uiColor: .black)
                builder.textTrackStyle = textStyle
            }

            let mediaInfo = builder.build()

            let loadOptions = GCKMediaLoadOptions()
            loadOptions.autoplay = true
            loadOptions.playPosition = currentTime

            if let activeId = activeTrackId, activeId > 0 {
                loadOptions.activeTrackIDs = [NSNumber(value: activeId)]
            }

            client.loadMedia(mediaInfo, with: loadOptions)
            client.add(self!)
            self?.startPolling()

            call.resolve()
        }
    }

    @objc func play(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.currentSession?.remoteMediaClient?.play()
            call.resolve()
        }
    }

    @objc func pause(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.currentSession?.remoteMediaClient?.pause()
            call.resolve()
        }
    }

    @objc func seek(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            let time = call.getDouble("time") ?? 0
            let options = GCKMediaSeekOptions()
            options.interval = time
            self?.currentSession?.remoteMediaClient?.seek(with: options)
            call.resolve()
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.currentSession?.remoteMediaClient?.stop()
            self?.stopPolling()
            call.resolve()
        }
    }

    @objc func setActiveSubtitle(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            let trackId = call.getInt("trackId") ?? 0
            let client = self?.currentSession?.remoteMediaClient
            if trackId > 0 {
                client?.setActiveTrackIDs([NSNumber(value: trackId)])
            } else {
                client?.setActiveTrackIDs([])
            }
            call.resolve()
        }
    }

    // MARK: - Session Manager Listener

    public func sessionManager(_ sessionManager: GCKSessionManager, didStart session: GCKCastSession) {
        sessionStarting = false
        emitCastState(connected: true)
    }

    public func sessionManager(_ sessionManager: GCKSessionManager, willStart session: GCKCastSession) {
        sessionStarting = true
    }

    public func sessionManager(_ sessionManager: GCKSessionManager, didResumeSession session: GCKCastSession) {
        emitCastState(connected: true)
    }

    public func sessionManager(_ sessionManager: GCKSessionManager, didEnd session: GCKSession, withError error: (any Error)?) {
        stopPolling()
        emitCastState(connected: false)
    }

    public func sessionManager(_ sessionManager: GCKSessionManager, didFailToStart session: GCKSession, withError error: any Error) {
        stopPolling()
        emitCastState(connected: false)
        emitPickerDismissed()
    }

    // MARK: - Discovery Manager Listener

    public func didUpdateDeviceList() {
        let dm = GCKCastContext.sharedInstance().discoveryManager
        print("[CastPlugin] didUpdateDeviceList: deviceCount=\(dm.deviceCount)")
        for i in 0..<dm.deviceCount {
            let device = dm.device(at: i)
            print("[CastPlugin]   device[\(i)]: \(device.friendlyName ?? "?") @ \(device.ipAddress ?? "?")")
        }
        emitAvailability(dm.deviceCount > 0)
    }

    private func emitAvailability(_ available: Bool) {
        let js = "window.dispatchEvent(new CustomEvent('castAvailabilityChanged', { detail: { available: \(available) } }));"
        DispatchQueue.main.async { [weak self] in
            self?.bridge?.webView?.evaluateJavaScript(js)
        }
    }

    // MARK: - Polling

    private func startPolling() {
        stopPolling()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            DispatchQueue.main.async {
                self?.pollMediaState()
            }
        }
    }

    private func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    private func pollMediaState() {
        guard let client = currentSession?.remoteMediaClient,
              let status = client.mediaStatus else { return }

        let time = client.approximateStreamPosition()
        let duration = status.mediaInformation?.streamDuration ?? 0
        let paused = status.playerState == .paused

        emitMediaUpdate(time: time, duration: duration, paused: paused)
    }

    // MARK: - Helpers

    private var currentSession: GCKCastSession? {
        return sessionManager?.currentCastSession
    }

    private func emitCastState(connected: Bool) {
        let js = "window.dispatchEvent(new CustomEvent('castStateChanged', { detail: { connected: \(connected) } }));"
        DispatchQueue.main.async { [weak self] in
            self?.bridge?.webView?.evaluateJavaScript(js)
        }
    }

    private func emitPickerDismissed() {
        let js = "window.dispatchEvent(new CustomEvent('castPickerDismissed'));"
        DispatchQueue.main.async { [weak self] in
            self?.bridge?.webView?.evaluateJavaScript(js)
        }
    }

    private func emitMediaUpdate(time: TimeInterval, duration: TimeInterval, paused: Bool) {
        let js = "window.dispatchEvent(new CustomEvent('castMediaUpdate', { detail: { currentTime: \(time), duration: \(duration), isPaused: \(paused) } }));"
        DispatchQueue.main.async { [weak self] in
            self?.bridge?.webView?.evaluateJavaScript(js)
        }
    }
}
