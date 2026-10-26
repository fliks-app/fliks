import Foundation
import UIKit
import Capacitor
import GoogleCast

@objc(CastPlugin)
public class CastPlugin: CAPPlugin, CAPBridgedPlugin, GCKSessionManagerListener, GCKRemoteMediaClientListener, GCKDiscoveryManagerListener, GCKRequestDelegate, GCKGenericChannelDelegate {
    public let identifier = "CastPlugin"
    public let jsName = "NativeCast"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "initialize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setResumeState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setHeartbeat", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isConnected", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getCastDevices", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "selectCastDevice", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "loadMedia", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seek", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setActiveSubtitle", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVolume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setMuted", returnType: CAPPluginReturnPromise),
    ]

    var sessionManager: GCKSessionManager?
    /** Receiver → sender channel for qoe samples and player errors, forwarded to JS verbatim. */
    var fliksChannel: GCKGenericChannel?
    var fliksChannelSession: GCKCastSession?
    static let fliksNamespace = "urn:x-cast:media.fliks.app"
    var pollTimer: Timer?
    /** LOAD calls awaiting the receiver's verdict, by request id: popping one settles it exactly once. */
    var pendingLoads: [Int: CAPPluginCall] = [:]
    /// Whether the media-status poll ran at backgrounding; restarted on foreground (Timers keep running
    /// under `UIBackgroundModes: audio`, so it would hit a paused WebView).
    var pollWasActiveBeforeBackground = false
    /// Keeps the playback position heartbeat going while the phone is locked and the WebView suspended.
    let heartbeat = PositionHeartbeat()
    var heartbeatTimer: Timer?

    // MARK: - Initialize

    @objc func initialize(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }

            // GCKCastContext already initialized in AppDelegate
            self.sessionManager = GCKCastContext.sharedInstance().sessionManager
            self.sessionManager?.add(self)

            // Pause the media-status poll in the background: the WebView is suspended, so bridge round-trips are wasted.
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(self.appDidEnterBackground),
                name: UIApplication.didEnterBackgroundNotification,
                object: nil
            )
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(self.appWillEnterForeground),
                name: UIApplication.willEnterForegroundNotification,
                object: nil
            )

            // Listen for device discovery
            let discoveryManager = GCKCastContext.sharedInstance().discoveryManager
            discoveryManager.add(self)

            let hasDevices = discoveryManager.deviceCount > 0
            print("[CastPlugin] initialize: discoveryState=\(discoveryManager.discoveryState.rawValue), deviceCount=\(discoveryManager.deviceCount), hasDevices=\(hasDevices)")

            // A session that outlived the WebView or the process: hand it and the sender's state back.
            var result: [String: Any] = ["available": hasDevices]
            if let session = self.currentSession, session.connectionState == .connected,
               let client = session.remoteMediaClient {
                self.live = true
                result["available"] = true
                result["connected"] = true
                if let resume = self.savedResumeState(session.sessionID),
                   client.mediaStatus?.mediaInformation != nil {
                    result["resume"] = resume
                    client.add(self)
                    self.startPolling()
                }
            }
            call.resolve(result)

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

    @objc func setHeartbeat(_ call: CAPPluginCall) {
        guard let url = call.getString("url"), let token = call.getString("token"),
              let body = call.getObject("body") else {
            call.reject("url, token and body are required")
            return
        }
        DispatchQueue.main.async { [weak self] in
            self?.heartbeat.set(url: url, token: token, body: body as [String: Any])
            call.resolve()
        }
    }

    // MARK: - Resume state

    static let resumeKey = "fliksCastResume"
    /** A connected session went through this process, so its end is a real stop. */
    var live = false
    /** Resume state waiting for a resumed session's first media status. */
    var pendingResume: [String: Any]?

    /// Keyed by the GCK session id so a process restart takes the session back and a later
    /// session never picks up an old cast's state. JSON: UserDefaults rejects the state's nulls.
    @objc func setResumeState(_ call: CAPPluginCall) {
        let state = call.getObject("state")
        DispatchQueue.main.async { [weak self] in
            if let state = state, let sid = self?.currentSession?.sessionID,
               self?.currentSession?.connectionState == .connected,
               let data = try? JSONSerialization.data(withJSONObject: ["sessionId": sid, "state": state]) {
                UserDefaults.standard.set(data, forKey: Self.resumeKey)
            }
            call.resolve()
        }
    }

    func savedResumeState(_ sessionID: String?) -> [String: Any]? {
        guard let sessionID = sessionID,
              let data = UserDefaults.standard.data(forKey: Self.resumeKey),
              let saved = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              saved["sessionId"] as? String == sessionID else { return nil }
        return saved["state"] as? [String: Any]
    }

    func onConnected(_ session: GCKCastSession) {
        live = true
        attachFliksChannel(session)
        guard let resume = savedResumeState(session.sessionID), let client = session.remoteMediaClient else {
            emitCastState(connected: true)
            return
        }
        client.add(self)
        if client.mediaStatus?.mediaInformation != nil {
            handBack(resume)
        } else {
            // A resumed session only knows its media after the first status.
            pendingResume = resume
            client.requestStatus()
        }
    }

    func handBack(_ resume: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: ["connected": true, "resume": resume]),
              let json = String(data: data, encoding: .utf8) else { return }
        startPolling()
        let js = "window.dispatchEvent(new CustomEvent('castStateChanged', { detail: \(json) }));"
        DispatchQueue.main.async { [weak self] in
            self?.bridge?.webView?.evaluateJavaScript(js)
        }
    }

    public func remoteMediaClient(_ client: GCKRemoteMediaClient, didUpdate mediaStatus: GCKMediaStatus?) {
        guard let resume = pendingResume else { return }
        pendingResume = nil
        if mediaStatus?.mediaInformation != nil {
            handBack(resume)
        } else {
            emitCastState(connected: true)
        }
    }

    // MARK: - Connection

    @objc func isConnected(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            let connected = self?.currentSession?.remoteMediaClient != nil
            call.resolve(["connected": connected])
        }
    }

    var sessionStarting = false

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

    func pollForDialogDismiss() {
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

    /// Lets the web layer render its own device list instead of the native chooser dialog.
    @objc func getCastDevices(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let dm = GCKCastContext.sharedInstance().discoveryManager
            var devices: [[String: Any]] = []
            for i in 0..<dm.deviceCount {
                let device = dm.device(at: i)
                var entry: [String: Any] = [
                    "id": device.deviceID,
                    "name": device.friendlyName ?? device.deviceID
                ]
                if let modelName = device.modelName {
                    entry["modelName"] = modelName
                }
                devices.append(entry)
            }
            call.resolve(["devices": devices])
        }
    }

    @objc func selectCastDevice(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let id = call.getString("id") else {
                print("[CastPlugin] selectCastDevice: missing id")
                call.reject("Missing device id")
                return
            }
            let dm = GCKCastContext.sharedInstance().discoveryManager
            var target: GCKDevice?
            for i in 0..<dm.deviceCount {
                let device = dm.device(at: i)
                if device.deviceID == id {
                    target = device
                    break
                }
            }
            guard let device = target else {
                print("[CastPlugin] selectCastDevice: no device matches id \(id)")
                call.reject("No matching Cast device")
                return
            }
            // The listener reports the outcome (didStart / didFailToStart); this
            // return only says whether the attempt was even accepted.
            guard self?.sessionManager?.startSession(with: device) == true else {
                print("[CastPlugin] selectCastDevice: startSession refused for \(id)")
                call.reject("Could not start a Cast session")
                return
            }
            call.resolve()
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
            // Side-channel the Fliks receiver reads (media ids, EDL ranges).
            builder.customData = call.getObject("customData")

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
            }
            // Always set the style: the receiver's defaults otherwise mask the user's prefs when the LOAD has no preselected subtitle track.
            let spec = call.getObject("textTrackStyle")
            builder.textTrackStyle = self?.buildTextTrackStyle(spec)

            let mediaInfo = builder.build()

            let loadOptions = GCKMediaLoadOptions()
            loadOptions.autoplay = true
            loadOptions.playPosition = currentTime

            if let activeId = activeTrackId, activeId > 0 {
                loadOptions.activeTrackIDs = [NSNumber(value: activeId)]
            }

            let request = client.loadMedia(mediaInfo, with: loadOptions)
            self?.pendingLoads[Int(request.requestID)] = call
            request.delegate = self
        }
    }

    public func requestDidComplete(_ request: GCKRequest) {
        guard let call = pendingLoads.removeValue(forKey: Int(request.requestID)) else { return }
        currentSession?.remoteMediaClient?.add(self)
        startPolling()
        call.resolve()
    }

    public func request(_ request: GCKRequest, didFailWithError error: GCKError) {
        pendingLoads.removeValue(forKey: Int(request.requestID))?
            .reject("Load failed: \(error.code) \(error.localizedDescription)", "LOAD_FAILED")
    }

    public func request(_ request: GCKRequest, didAbortWith abortReason: GCKRequestAbortReason) {
        pendingLoads.removeValue(forKey: Int(request.requestID))?
            .reject("Load aborted: \(abortReason.rawValue)", "LOAD_FAILED")
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

    @objc func setVolume(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            let level = Float(call.getDouble("level") ?? 1.0)
            self?.currentSession?.setDeviceVolume(max(0, min(1, level)))
            call.resolve()
        }
    }

    @objc func setMuted(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            let muted = call.getBool("muted") ?? false
            self?.currentSession?.setDeviceMuted(muted)
            call.resolve()
        }
    }

    @objc func setActiveSubtitle(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            let trackId = call.getInt("trackId") ?? 0
            if let client = self?.currentSession?.remoteMediaClient {
                // The receiver replaces the whole active set, so the active audio goes along.
                var ids = CastPlugin.activeAudioTrackIDs(of: client)
                if trackId > 0 { ids.append(NSNumber(value: trackId)) }
                client.setActiveTrackIDs(ids)
            }
            call.resolve()
        }
    }

    static func activeAudioTrackIDs(of client: GCKRemoteMediaClient) -> [NSNumber] {
        guard let status = client.mediaStatus,
              let tracks = status.mediaInformation?.mediaTracks else { return [] }
        let audio = Set(tracks.filter { $0.type == .audio }.map { $0.identifier })
        return (status.activeTrackIDs ?? []).filter { audio.contains($0.intValue) }
    }
}
