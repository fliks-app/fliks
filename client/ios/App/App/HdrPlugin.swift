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
        // Apple's HLS spec lists P5 and P10 (AV1) for iOS; P8.1 lands in iOS 27. The
        // list can't say "8.4 only", so 8 waits for 27 (8.x still plays via its base layer).
        var profiles: [Int] = []
        if supported {
            profiles.append(5)
            if #available(iOS 27.0, *) {
                profiles.append(8)
            }
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
