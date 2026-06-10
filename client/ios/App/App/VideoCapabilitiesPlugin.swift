import Foundation
import Capacitor
import UIKit

@objc(VideoCapabilitiesPlugin)
public class VideoCapabilitiesPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VideoCapabilitiesPlugin"
    public let jsName = "VideoCapabilities"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getSupported", returnType: CAPPluginReturnPromise),
    ]

    /// Reports the video codecs AVPlayer can decode on this device so the
    /// profile reflects VideoToolbox capability rather than the WebView MSE
    /// (which under-reports HEVC). H.264 is universal; HEVC — including Main10
    /// — is hardware-decoded across the iOS 11+ device range (A9 and newer).
    /// AVPlayer demuxes the ISO-BMFF family only, so MKV/WebM are never
    /// advertised (those still remux/transcode server-side).
    @objc func getSupported(_ call: CAPPluginCall) {
        var codecs: [String] = ["h264"]
        var hevcMain10 = false

        if #available(iOS 11.0, tvOS 11.0, *) {
            codecs.append("hevc")
            hevcMain10 = true
        }

        call.resolve([
            "videoCodecs": codecs,
            "hevcMain10": hevcMain10,
            "av1Main10": false,
            "containers": ["mp4", "m4v", "mov"],
        ])
    }
}
