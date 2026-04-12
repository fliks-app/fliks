import Foundation
import Capacitor
import AVFoundation

@objc(HdrPlugin)
public class HdrPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HdrPlugin"
    public let jsName = "Hdr"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
    ]

    @objc func isSupported(_ call: CAPPluginCall) {
        let supported = AVPlayer.eligibleForHDRPlayback
        call.resolve(["supported": supported])
    }
}
