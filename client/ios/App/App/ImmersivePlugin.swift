import Foundation
import Capacitor
import UIKit

/**
 * Capacitor plugin to toggle iOS immersive mode.
 * Hides the status bar and optionally the home indicator.
 *
 * Usage from JS:
 *   Immersive.enter({ displayBehindNotch: true })
 *   Immersive.exit()
 *   Immersive.setLightStatusBar({ light: true })
 */
@objc(ImmersivePlugin)
public class ImmersivePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ImmersivePlugin"
    public let jsName = "Immersive"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "enter", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exit", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setLightStatusBar", returnType: CAPPluginReturnPromise),
    ]

    @objc func enter(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            if let vc = self?.bridge?.viewController as? FlksViewController {
                vc.updateStatusBar(hidden: true)
            }
            call.resolve()
        }
    }

    @objc func exit(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            if let vc = self?.bridge?.viewController as? FlksViewController {
                vc.updateStatusBar(hidden: false)
            }
            call.resolve()
        }
    }

    @objc func setLightStatusBar(_ call: CAPPluginCall) {
        let light = call.getBool("light") ?? false
        DispatchQueue.main.async { [weak self] in
            if let vc = self?.bridge?.viewController as? FlksViewController {
                vc.updateStatusBarStyle(light: light)
            }
            call.resolve()
        }
    }
}
