import Foundation
import Capacitor
import UIKit

/// Backs the player's in-app orientation lock. `lock()` narrows the supported
/// orientations to the one currently on screen (frozen independently of the
/// Control Center rotation lock); `unlock()` restores free rotation. The mask is
/// stored on the AppDelegate and surfaced by FlksViewController.
@objc(OrientationPlugin)
public class OrientationPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "OrientationPlugin"
    public let jsName = "Orientation"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "lock", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unlock", returnType: CAPPluginReturnPromise),
    ]

    @objc func lock(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.apply(self?.currentInterfaceMask() ?? .allButUpsideDown)
            call.resolve()
        }
    }

    @objc func unlock(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.apply(.allButUpsideDown)
            call.resolve()
        }
    }

    // The orientation currently on screen, as a single-orientation mask.
    private func currentInterfaceMask() -> UIInterfaceOrientationMask {
        switch windowScene()?.interfaceOrientation {
        case .portrait: return .portrait
        case .portraitUpsideDown: return .portraitUpsideDown
        case .landscapeLeft: return .landscapeLeft
        case .landscapeRight: return .landscapeRight
        default: return .allButUpsideDown
        }
    }

    private func apply(_ mask: UIInterfaceOrientationMask) {
        guard let delegate = UIApplication.shared.delegate as? AppDelegate else { return }
        guard delegate.orientationLock != mask else { return }
        delegate.orientationLock = mask
        guard let vc = bridge?.viewController else { return }
        if #available(iOS 16.0, *) {
            vc.setNeedsUpdateOfSupportedInterfaceOrientations()
            windowScene()?.requestGeometryUpdate(.iOS(interfaceOrientations: mask))
        } else {
            UIViewController.attemptRotationToDeviceOrientation()
        }
    }

    private func windowScene() -> UIWindowScene? {
        return UIApplication.shared.connectedScenes
            .first { $0.activationState == .foregroundActive } as? UIWindowScene
            ?? UIApplication.shared.connectedScenes.first as? UIWindowScene
    }
}
