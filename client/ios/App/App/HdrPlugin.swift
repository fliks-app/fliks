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
        // eligibleForHDRPlayback covers profiles 5 and 8.4 per Apple's "Incorporating
        // HDR video with Dolby Vision" doc; 10 (AV1) has a real hardware probe instead.
        var profiles: [Int] = []
        if supported {
            profiles.append(5)
            profiles.append(8)
            if #available(iOS 17.0, *), VTIsHardwareDecodeSupported(kCMVideoCodecType_AV1) {
                profiles.append(10)
            }
        }
        call.resolve([
            "supported": supported,
            "dolbyVision": supported,
            "dolbyVisionProfiles": profiles,
        ])
    }
}
