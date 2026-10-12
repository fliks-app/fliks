import Foundation

/// One selectable subtitle rendition, in the id scheme the web client and remote
/// controllers use: `emb-<streamIndex>` for in-container tracks, `ext-<id>` for sidecar files.
struct SubtitleTrack: Equatable {
    let id: String
    let language: String?
    let forced: Bool
    let hearingImpaired: Bool
    /// Translated or OCR'd: reads worse than a real track, so it loses every tie.
    let machineMade: Bool
}

/// Audio and subtitle choice rules, ported from the web client's
/// `PlayerSettingsService.resolveAudioStreamIndex` and `track-manager`'s `pickSubtitle`.
/// Pure on purpose: no AVFoundation, no settings reads.
enum TrackSelection {
    /// ISO 639-2/B codes whose terminology (T) form differs; the other three-letter
    /// codes are already T.
    private static let bibliographicToTerminology = [
        "alb": "sqi", "arm": "hye", "baq": "eus", "bur": "mya", "chi": "zho", "cze": "ces",
        "dut": "nld", "fre": "fra", "geo": "kat", "ger": "deu", "gre": "ell", "ice": "isl",
        "mac": "mkd", "mao": "mri", "may": "msa", "per": "fas", "rum": "ron", "slo": "slk",
        "tib": "bod", "wel": "cym",
    ]

    /// Canonical ISO 639-1 code of any tag (`fre`, `fra`, `fr`, `fr-CA`); nil when the
    /// language is unknown (`und`, empty), so an untagged track never matches a preference.
    static func canonicalLanguage(_ tag: String?) -> String? {
        guard let tag,
              let base = tag.split(whereSeparator: { $0 == "-" || $0 == "_" }).first?.lowercased(),
              base != "und" else { return nil }
        if base.count == 2 { return base }
        let terminology = bibliographicToTerminology[base] ?? base
        return Locale.LanguageCode(terminology).identifier(.alpha2) ?? terminology
    }

    /// Position in `streams` of the audio track to start with; nil only when there are none.
    /// A main track of the preferred language (default-flagged first), else the file's
    /// default-flagged track in "use default" mode, else the first.
    static func audioIndex(in streams: [AudioStreamInfo], preferredLanguage: String, useDefault: Bool) -> Int? {
        guard !streams.isEmpty else { return nil }
        if !useDefault, let wanted = canonicalLanguage(preferredLanguage) {
            let sameLanguage = streams.indices.filter { canonicalLanguage(streams[$0].language) == wanted }
            let main = sameLanguage.filter { streams[$0].commentary != true && streams[$0].audioDescription != true }
            let pool = main.isEmpty ? sameLanguage : main
            if let index = pool.first(where: { streams[$0].isDefault == true }) ?? pool.first { return index }
        }
        if useDefault, let index = streams.firstIndex(where: { $0.isDefault == true }) { return index }
        return 0
    }

    /// The HLS `subs` group in rendition order: text embedded tracks in source order,
    /// then sidecar files by id (backend `listTextSubtitleRenditions`).
    static func subtitleTracks(embedded: [SubtitleStreamInfo], external: [SubtitleFileRow]) -> [SubtitleTrack] {
        let inContainer = embedded.filter { !isImageBasedSubtitleCodec($0.codec) }.map {
            SubtitleTrack(id: "emb-\($0.streamIndex)", language: canonicalLanguage($0.language),
                          forced: $0.forced, hearingImpaired: $0.hearingImpaired, machineMade: false)
        }
        let sidecars = external.filter(isRenderableTextSidecar).sorted { $0.id < $1.id }.map {
            SubtitleTrack(id: "ext-\($0.id)", language: canonicalLanguage($0.language),
                          forced: $0.forced ?? false, hearingImpaired: $0.hearingImpaired ?? false,
                          machineMade: $0.providerType == "translated" || $0.providerType == "ocr")
        }
        return inContainer + sidecars
    }

    /// Index of the track to auto-select for `language`: forced-ness first (a forced
    /// track only, when `forcedOnly`), then a non-hearing-impaired one, then a real
    /// track over a machine-made one. Hearing-impaired is avoided, never excluded.
    static func pickSubtitle(_ tracks: [SubtitleTrack], language: String, forcedOnly: Bool) -> Int? {
        func rank(_ track: SubtitleTrack) -> Int {
            (track.forced == forcedOnly ? 0 : 4) + (track.hearingImpaired ? 2 : 0) + (track.machineMade ? 1 : 0)
        }
        return tracks.indices
            .filter { tracks[$0].language == language && (!forcedOnly || tracks[$0].forced) }
            .min { rank(tracks[$0]) < rank(tracks[$1]) }
    }

    private static let textSidecarExtensions: Set<String> = ["srt", "ass", "ssa", "vtt"]

    /// Mirrors the backend's `isRenderableTextSidecar`: a sidecar the `subs` group lists
    /// is a text codec in a text file.
    private static func isRenderableTextSidecar(_ row: SubtitleFileRow) -> Bool {
        guard let path = row.relativePath, !path.isEmpty,
              textSidecarExtensions.contains((path as NSString).pathExtension.lowercased()) else { return false }
        return !isImageBasedSubtitleCodec(row.codec ?? "")
    }

    /// Bitmap codecs the backend never puts in the HLS `subs` group, only burns in:
    /// mirrors the backend/web `IMAGE_BASED_SUBTITLE_CODECS` set.
    private static let imageBasedSubtitleCodecs: Set<String> = [
        "hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "xsub",
    ]
    private static func isImageBasedSubtitleCodec(_ codec: String) -> Bool {
        imageBasedSubtitleCodecs.contains(codec)
    }
}
