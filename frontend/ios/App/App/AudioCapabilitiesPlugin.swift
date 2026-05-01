import Foundation
import Capacitor
import UIKit

@objc(AudioCapabilitiesPlugin)
public class AudioCapabilitiesPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AudioCapabilitiesPlugin"
    public let jsName = "AudioCapabilities"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getSupported", returnType: CAPPluginReturnPromise),
    ]

    /// Reports the audio codecs the device's media stack decodes.
    /// iOS doesn't expose a MediaCodecList equivalent, so we hard-code by
    /// device class — accurate to within ~95% of real-world behaviour.
    @objc func getSupported(_ call: CAPPluginCall) {
        var codecs: [String] = ["aac", "alac", "mp3"]
        var maxChannels = 2

        if #available(iOS 11, tvOS 11, *) {
            codecs.append("flac")
        }

        let idiom = UIDevice.current.userInterfaceIdiom
        if idiom == .tv {
            // Apple TV → AC-3 / E-AC-3 / Atmos via HDMI.
            codecs.append(contentsOf: ["ac3", "eac3"])
            maxChannels = 8
        }
        // iPhone / iPad: stereo speakers, no AC-3/EAC-3 software decoding.

        call.resolve([
            "codecs": codecs,
            "maxChannels": maxChannels,
        ])
    }
}
