import Foundation
import Capacitor
import AVFoundation
import VideoToolbox
import CoreMedia

@objc(VideoCapabilitiesPlugin)
public class VideoCapabilitiesPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VideoCapabilitiesPlugin"
    public let jsName = "VideoCapabilities"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getSupported", returnType: CAPPluginReturnPromise),
    ]

    /// HEVC and AV1 come from VideoToolbox, Main10 from AVFoundation on a 10-bit codec string, containers from its MIME list.
    /// AVPlayer never demuxes MKV/WebM: those remux or transcode server-side.
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
            "hevcMain10": hevc && Self.plays("hvc1.2.4.L120.B0"),
            "av1Main10": av1 && Self.plays("av01.0.08M.10"),
            "containers": Self.containers(),
            "cropsBlackBars": true,
        ])
    }

    private static func plays(_ codec: String) -> Bool {
        AVURLAsset.isPlayableExtendedMIMEType("video/mp4; codecs=\"\(codec)\"")
    }

    /// Containers AVFoundation lists among its audiovisual MIME types, in the server's names.
    static func containers(types: [String] = AVURLAsset.audiovisualMIMETypes()) -> [String] {
        let known: [(mime: String, containers: [String])] = [
            ("video/mp4", ["mp4"]),
            ("video/quicktime", ["mov"]),
            ("video/x-m4v", ["m4v"]),
        ]
        return known.filter { types.contains($0.mime) }.flatMap(\.containers)
    }
}
