import Foundation
import Capacitor
import VideoToolbox
import CoreMedia

@objc(VideoCapabilitiesPlugin)
public class VideoCapabilitiesPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VideoCapabilitiesPlugin"
    public let jsName = "VideoCapabilities"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getSupported", returnType: CAPPluginReturnPromise),
    ]

    /// Reports the video codecs the device can hardware-decode, queried at
    /// runtime from VideoToolbox rather than guessed from the OS version — H.264
    /// is universal; HEVC and AV1 are asked of `VTIsHardwareDecodeSupported` so
    /// only devices with the actual decoder (HEVC: A9+, AV1: A17 Pro / M3+) are
    /// told they can Direct Play them. Their hardware decoders are 10-bit, so the
    /// Main10 flags follow the codec. AVPlayer demuxes the ISO-BMFF family only,
    /// so MKV/WebM are never advertised (those still remux/transcode server-side).
    @objc func getSupported(_ call: CAPPluginCall) {
        var codecs: [String] = ["h264"]
        var hevc = false
        var av1 = false

        if #available(iOS 11.0, tvOS 11.0, *) {
            hevc = VTIsHardwareDecodeSupported(kCMVideoCodecType_HEVC)
            if hevc { codecs.append("hevc") }
        }

        if #available(iOS 16.0, tvOS 16.0, *) {
            av1 = VTIsHardwareDecodeSupported(kCMVideoCodecType_AV1)
            if av1 { codecs.append("av1") }
        }

        call.resolve([
            "videoCodecs": codecs,
            "hevcMain10": hevc,
            "av1Main10": av1,
            "containers": ["mp4", "m4v", "mov"],
        ])
    }
}
