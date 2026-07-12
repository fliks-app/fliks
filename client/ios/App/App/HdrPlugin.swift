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
        // iOS has no public per-codec Dolby Vision probe; DV playback tracks HDR
        // eligibility on AVPlayer (HDR-eligible iPhone/iPad/Apple TV models decode
        // DV P5/P8.1), so the HDR signal doubles as the DV one.
        call.resolve(["supported": supported, "dolbyVision": supported])
    }
}
