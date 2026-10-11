import Foundation
import Capacitor
import AVFoundation
import AVKit

/**
 * Capacitor plugin for native iOS Picture-in-Picture.
 * Uses AVPictureInPictureController backed by NativePlayerPlugin's AVPlayerLayer.
 *
 * Usage from JS:
 *   Pip.enter()
 *   Pip.setAutoEnter({ enabled: true })
 *   Pip.updatePlaybackState({ playing: true })  // no-op on iOS
 */
@objc(PipPlugin)
public class PipPlugin: CAPPlugin, CAPBridgedPlugin, AVPictureInPictureControllerDelegate {
    public let identifier = "PipPlugin"
    public let jsName = "Pip"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "enter", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setAutoEnter", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updatePlaybackState", returnType: CAPPluginReturnPromise),
    ]

    private var pipController: AVPictureInPictureController?
    // Remembered so a layer created after the JS call still gets auto-PiP.
    private var autoEnter = false

    @objc func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": AVPictureInPictureController.isPictureInPictureSupported()])
    }

    @objc func enter(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else {
                call.reject("Plugin not available")
                return
            }

            let controller = self.getOrCreateController()
            guard let controller = controller else {
                call.reject("PiP not available — no active player layer")
                return
            }

            if controller.isPictureInPictureActive {
                call.resolve()
                return
            }

            controller.startPictureInPicture()
            call.resolve()
        }
    }

    @objc func setAutoEnter(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? false

        DispatchQueue.main.async { [weak self] in
            guard let self = self else {
                call.resolve()
                return
            }

            self.autoEnter = enabled
            self.applyAutoEnter(to: self.getOrCreateController())
            call.resolve()
        }
    }

    @objc func updatePlaybackState(_ call: CAPPluginCall) {
        // No-op on iOS — the native PiP controller automatically reflects
        // AVPlayer's play/pause state. Unlike Android where we manually
        // build RemoteActions for the PiP window.
        call.resolve()
    }

    // MARK: - Private

    private var nativePlayer: NativePlayerPlugin? {
        bridge?.plugin(withName: "NativePlayer") as? NativePlayerPlugin
    }

    /// Called by NativePlayerPlugin once its AVPlayerLayer exists.
    func playerLayerDidChange() {
        applyAutoEnter(to: getOrCreateController())
    }

    private func applyAutoEnter(to controller: AVPictureInPictureController?) {
        if #available(iOS 14.2, *) {
            controller?.canStartPictureInPictureAutomaticallyFromInline = autoEnter
        }
    }

    private func getOrCreateController() -> AVPictureInPictureController? {
        let layer = nativePlayer?.activePlayerLayer
        if let existing = pipController, existing.playerLayer === layer { return existing }
        pipController = nil

        guard AVPictureInPictureController.isPictureInPictureSupported() else { return nil }

        guard let playerLayer = layer else { return nil }

        guard let controller = AVPictureInPictureController(playerLayer: playerLayer) else {
            return nil
        }
        controller.delegate = self
        pipController = controller
        applyAutoEnter(to: controller)
        return controller
    }

    // MARK: - AVPictureInPictureControllerDelegate

    public func pictureInPictureControllerWillStartPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        // The custom subtitle overlay isn't captured by PiP — hand rendering to
        // the native (boxed) caption track for the duration of the PiP window.
        nativePlayer?.setSubtitleRenderingForPiP(true)
    }

    public func pictureInPictureControllerDidStartPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        emitPipModeChanged(true)
    }

    public func pictureInPictureControllerWillStopPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        // Re-suppress and clear the native caption now; the overlay is revealed
        // only once PiP has fully exited (didStop) so it doesn't overlap the
        // boxed caption during the restore animation.
        nativePlayer?.setSubtitleRenderingForPiP(false)
    }

    public func pictureInPictureControllerDidStopPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        nativePlayer?.finishSubtitlePiPExit()
        // PiP transferred the shared AVPlayerLayer into its window; the inline
        // layer can come back not-presenting (black) once PiP releases it.
        nativePlayer?.reassertVideoPresentation()
        emitPipModeChanged(false)
    }

    public func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void) {
        // Re-present the inline layer before signalling the restore is done,
        // so the full-app UI never reappears over a black (sourceless) layer.
        nativePlayer?.reassertVideoPresentation()
        completionHandler(true)
    }

    public func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, failedToStartPictureInPictureWithError error: Error) {
        print("PiP failed to start: \(error.localizedDescription)")
        pipController = nil
    }

    // MARK: - Event Emitters

    private func emitPipModeChanged(_ isInPipMode: Bool) {
        let js = "window.dispatchEvent(new CustomEvent('pipModeChanged', { detail: { isInPipMode: \(isInPipMode) } }));"
        DispatchQueue.main.async { [weak self] in
            self?.bridge?.webView?.evaluateJavaScript(js)
        }
    }
}
