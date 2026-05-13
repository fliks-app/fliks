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

            let controller = self.getOrCreateController()
            if #available(iOS 14.2, *) {
                controller?.canStartPictureInPictureAutomaticallyFromInline = enabled
            }
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

    private func getOrCreateController() -> AVPictureInPictureController? {
        if let existing = pipController { return existing }

        guard AVPictureInPictureController.isPictureInPictureSupported() else { return nil }

        // Get the player layer from NativePlayerPlugin
        guard let nativePlayer = bridge?.plugin(withName: "NativePlayer") as? NativePlayerPlugin,
              let playerLayer = nativePlayer.activePlayerLayer else {
            return nil
        }

        guard let controller = AVPictureInPictureController(playerLayer: playerLayer) else {
            return nil
        }
        controller.delegate = self
        pipController = controller
        return controller
    }

    // MARK: - AVPictureInPictureControllerDelegate

    public func pictureInPictureControllerDidStartPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        emitPipModeChanged(true)
    }

    public func pictureInPictureControllerDidStopPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        emitPipModeChanged(false)
        pipController = nil
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
