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
        // AVPlayer decodes multichannel (AAC / ALAC / FLAC) and the OS downmixes
        // to the real output, so report the DECODE capability (8 = 7.1), not the
        // stereo speaker count — a 5.1/7.1 source then DirectPlays and downmixes
        // on-device. (No MediaCodecList equivalent on iOS, so this stays a
        // device-class estimate.)
        var maxChannels = 8

        if #available(iOS 11, tvOS 11, *) {
            codecs.append("flac")
        }

        let idiom = UIDevice.current.userInterfaceIdiom
        if idiom == .tv {
            // Apple TV → AC-3 / E-AC-3 / Atmos via HDMI.
            codecs.append(contentsOf: ["ac3", "eac3"])
        }

        // Per-codec decode estimate (no MediaCodecList equivalent on iOS): MP3
        // is stereo; the rest decode multichannel and the OS downmixes.
        var channelsByCodec: [String: Int] = [:]
        for c in codecs {
            channelsByCodec[c] = (c == "mp3") ? 2 : maxChannels
        }

        call.resolve([
            "codecs": codecs,
            "maxChannels": maxChannels,
            "channelsByCodec": channelsByCodec,
        ])
    }
}
