import Foundation
import UIKit
import AVFoundation
import VideoToolbox
import AudioToolbox

/// One entry of `DeviceProfileDto.directPlayProfiles` — container + codec sets
/// the device claims it can play as a raw progressive file.
struct DirectPlayProfile: Encodable {
    let containers: [String]
    let videoCodecs: [String]
    let audioCodecs: [String]
}

/// Fine-grained codec gate. `codec` is matched against the source's raw
/// ffprobe codec name (`server/crates/server/src/stream/info.rs`).
struct CodecCondition: Encodable {
    let codec: String
    var maxLevel: Int? = nil
    var profiles: [String]? = nil
    var maxBitDepth: Int? = nil
    var maxWidth: Int? = nil
    var maxHeight: Int? = nil
}

/// Body of `POST /api/stream/:mediaFileId/playback-info` — mirrors the
/// device profile of `server/crates/server/src/stream/info.rs`. Advertises the
/// device's real native decode capabilities (probed below), not a fixed list.
struct DeviceProfile: Encodable {
    let directPlayProfiles: [DirectPlayProfile]
    let codecConditions: [CodecCondition]
    let maxStreamingBitrate: Int
    let maxAudioChannels: Int
    let supportsHdr: Bool
    let supportsDolbyVision: Bool
    let supportsDirectPlay: Bool
    let switchesDirectPlayAudio: Bool
    let supportsHlsSubtitles: Bool
    let supportsImageSubtitles: Bool
    /// Nil is omitted from the body: a server that doesn't advertise the field rejects it.
    let needsHlsSubtitles: Bool?
    /// Nil is omitted from the body, like `needsHlsSubtitles`.
    let supportsMuxedAudioRendition: Bool?
    let probesSegZero: Bool
    let deviceType: String
    let deviceName: String
    let systemName: String
    let appVersion: String?
    let useTs: Bool
}

enum DeviceProfileBuilder {
    private static let videoCodecs = probeVideoCodecs()
    private static let audioCodecs = probeAudioCodecs()
    private static let hdrModes = AVPlayer.availableHDRModes
    /// Read per build: the receiver can be switched on after launch.
    private static var audioChannels: Int { max(2, AVAudioSession.sharedInstance().maximumOutputNumberOfChannels) }

    static func build(needsHlsSubtitles: Bool = false, supportsMuxedAudioRendition: Bool = false) -> DeviceProfile {
        let hevc10 = videoCodecs.contains("hevc") && !hdrModes.isEmpty
        return DeviceProfile(
            directPlayProfiles: [DirectPlayProfile(
                containers: ["mp4", "mov", "m4v"],
                videoCodecs: videoCodecs,
                audioCodecs: audioCodecs
            )],
            codecConditions: [
                CodecCondition(codec: "h264", profiles: ["baseline", "constrained baseline", "main", "high"], maxBitDepth: 8),
                CodecCondition(codec: "hevc", profiles: ["main", "main 10"], maxBitDepth: hevc10 ? 10 : 8),
            ],
            maxStreamingBitrate: 0, // 0 = no limit
            maxAudioChannels: audioChannels,
            supportsHdr: !hdrModes.isEmpty,
            supportsDolbyVision: hdrModes.contains(.dolbyVision),
            supportsDirectPlay: true,
            // AVPlayer can't switch tracks inside a progressive file: a non-first pick must go through HLS.
            switchesDirectPlayAudio: false,
            supportsHlsSubtitles: true,
            // AVFoundation doesn't decode PGS/VOBSUB bitmap tracks natively: the server burns them in.
            supportsImageSubtitles: false,
            // AVPlayer can't sideload a subtitle into a progressive item: it needs the HLS renditions.
            needsHlsSubtitles: needsHlsSubtitles ? true : nil,
            // AVKit names a single muxed track from a URI-less AUDIO rendition, else the menu reads "Unknown".
            supportsMuxedAudioRendition: supportsMuxedAudioRendition ? true : nil,
            // AVPlayer seeks straight to the resume segment; it never probes seg-0.
            probesSegZero: false,
            deviceType: "desktop",
            deviceName: UIDevice.current.name,
            systemName: "tvOS \(UIDevice.current.systemVersion)",
            appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
            useTs: false
        )
    }

    // h264 universal; hevc/av1 only when VideoToolbox reports a hardware decoder.
    private static func probeVideoCodecs() -> [String] {
        var codecs = ["h264"]
        if VTIsHardwareDecodeSupported(kCMVideoCodecType_HEVC) { codecs.append("hevc") }
        if VTIsHardwareDecodeSupported(kCMVideoCodecType_AV1) { codecs.append("av1") }
        return codecs + probeSampleEntries(codecs)
    }

    // Sample entries beyond each codec's own, as AVFoundation answers for a raw file (it refuses `hev1`).
    private static func probeSampleEntries(_ codecs: [String]) -> [String] {
        let probes: [(codec: String, entry: String, strings: [String])] = [
            ("h264", "avc3", ["avc3.640028"]),
            ("hevc", "hev1", ["hev1.1.6.L120.B0"]),
            ("hevc", "dvh1", ["dvh1.05.06", "dvh1.08.06"]),
            ("hevc", "dvhe", ["dvhe.05.06", "dvhe.08.06"]),
            ("av1", "dav1", ["dav1.10.06"]),
        ]
        return probes.filter { p in
            codecs.contains(p.codec)
                && p.strings.contains { AVURLAsset.isPlayableExtendedMIMEType("video/mp4; codecs=\"\($0)\"") }
        }.map(\.entry)
    }

    // System-decodable audio formats mapped to backend codec names; AAC floored.
    private static func probeAudioCodecs() -> [String] {
        let decodable = systemDecodeFormatIDs()
        let map: [(AudioFormatID, String)] = [
            (kAudioFormatMPEG4AAC, "aac"),
            (kAudioFormatAC3, "ac3"),
            (kAudioFormatEnhancedAC3, "eac3"),
            (kAudioFormatAppleLossless, "alac"),
            (kAudioFormatFLAC, "flac"),
            (kAudioFormatOpus, "opus"),
            (kAudioFormatMPEGLayer3, "mp3"),
        ]
        var codecs = map.filter { decodable.contains($0.0) }.map(\.1)
        if !codecs.contains("aac") { codecs.insert("aac", at: 0) }
        return codecs
    }

    private static func systemDecodeFormatIDs() -> Set<AudioFormatID> {
        var size: UInt32 = 0
        guard AudioFormatGetPropertyInfo(kAudioFormatProperty_DecodeFormatIDs, 0, nil, &size) == noErr, size > 0
        else { return [] }
        var ids = [AudioFormatID](repeating: 0, count: Int(size) / MemoryLayout<AudioFormatID>.size)
        guard AudioFormatGetProperty(kAudioFormatProperty_DecodeFormatIDs, 0, nil, &size, &ids) == noErr
        else { return [] }
        return Set(ids)
    }
}
