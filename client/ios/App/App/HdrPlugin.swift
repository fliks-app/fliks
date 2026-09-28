import Foundation
import Capacitor
import AVFoundation
import VideoToolbox
import CoreMedia

@objc(HdrPlugin)
public class HdrPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HdrPlugin"
    public let jsName = "Hdr"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
    ]

    @objc func isSupported(_ call: CAPPluginCall) {
        let supported = AVPlayer.eligibleForHDRPlayback
        // iOS has no public per-codec Dolby Vision probe, so HDR eligibility
        // stands in for profile 5; 8 and 10 need iOS 27 (AV1 needs its hardware too).
        var profiles: [Int] = []
        if supported {
            profiles.append(5)
            if #available(iOS 27.0, *) {
                profiles.append(8)
                if VTIsHardwareDecodeSupported(kCMVideoCodecType_AV1) {
                    profiles.append(10)
                }
            }
        }
        call.resolve([
            "supported": supported,
            "dolbyVision": supported,
            "dolbyVisionProfiles": profiles,
        ])
    }
}
