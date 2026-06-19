import Foundation
import Capacitor
import AudioToolbox

@objc(AudioCapabilitiesPlugin)
public class AudioCapabilitiesPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AudioCapabilitiesPlugin"
    public let jsName = "AudioCapabilities"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getSupported", returnType: CAPPluginReturnPromise),
    ]

    /// Our codec identifiers mapped to the Core Audio format IDs that stand for
    /// them. A codec is reported only when the system actually lists it as
    /// decodable (see `decodableFormatIDs`).
    private static let codecFormatIDs: [(name: String, id: AudioFormatID)] = [
        ("aac", kAudioFormatMPEG4AAC),
        ("aac", kAudioFormatMPEG4AAC_HE),
        ("alac", kAudioFormatAppleLossless),
        ("mp3", kAudioFormatMPEGLayer3),
        ("flac", kAudioFormatFLAC),
        ("ac3", kAudioFormatAC3),
        ("eac3", kAudioFormatEnhancedAC3),
        ("opus", kAudioFormatOpus),
    ]

    /// Reports the audio codecs the device's media stack decodes, queried at
    /// runtime from Core Audio rather than guessed per device class — iOS has
    /// no MediaCodecList, but `kAudioFormatProperty_DecodeFormatIDs` is the
    /// system's own list of decodable formats.
    @objc func getSupported(_ call: CAPPluginCall) {
        let decodable = Self.decodableFormatIDs()
        var codecs: [String] = []
        for (name, id) in Self.codecFormatIDs where decodable.contains(id) {
            if !codecs.contains(name) { codecs.append(name) }
        }
        // AAC is always decodable; guarantee it even if the query comes back
        // empty on some OS revision.
        if !codecs.contains("aac") { codecs.insert("aac", at: 0) }

        // AVFoundation decodes multichannel and the OS downmixes to the active
        // output (built-in speakers, headphones) or passes through over HDMI /
        // AirPlay, so report the decode ceiling, not the speaker count — a
        // 5.1/7.1 source then Direct Plays and downmixes on-device.
        let maxChannels = 8
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

    /// The set of audio format IDs the system can decode.
    private static func decodableFormatIDs() -> Set<AudioFormatID> {
        var size: UInt32 = 0
        guard AudioFormatGetPropertyInfo(
                kAudioFormatProperty_DecodeFormatIDs, 0, nil, &size) == noErr,
              size > 0 else { return [] }
        let count = Int(size) / MemoryLayout<AudioFormatID>.size
        var ids = [AudioFormatID](repeating: 0, count: count)
        guard AudioFormatGetProperty(
                kAudioFormatProperty_DecodeFormatIDs, 0, nil, &size, &ids) == noErr
        else { return [] }
        return Set(ids)
    }
}
