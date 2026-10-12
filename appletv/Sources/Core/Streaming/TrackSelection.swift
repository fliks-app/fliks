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
    /// Database id of a bitmap track, which only a server burn-in can show.
    var burnInId: Int? = nil
    /// BCP-47 tag of an embedded track (`pt-PT`): the variant a remembered pick pins down.
    var languageTag: String? = nil
}

/// The subtitle the settings put on screen for one item.
enum SubtitlePick: Equatable {
    /// Position in `TrackSelection.subtitleTracks`, i.e. in the HLS `subs` group.
    case text(Int)
    /// Database id of the bitmap track to burn into the video.
    case burnIn(Int)
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

    /// `pt_pt` -> `pt-PT`, `zh-hant` -> `zh-Hant`; "" when the tag names no variant past the language.
    static func normalizeLangTag(_ tag: String?) -> String {
        let parts = (tag ?? "").split(whereSeparator: { $0 == "-" || $0 == "_" }).map(String.init)
        guard parts.count > 1 else { return "" }
        let rest = parts.dropFirst().map { sub -> String in
            sub.count == 4 ? sub.prefix(1).uppercased() + sub.dropFirst().lowercased() : sub.uppercased()
        }
        return ([parts[0].lowercased()] + rest).joined(separator: "-")
    }

    private static func audioRole(_ stream: AudioStreamInfo) -> String {
        stream.commentary == true ? "commentary" : stream.audioDescription == true ? "ad" : "main"
    }

    /// The remembered form of a track, `language:role:channels[:variant]`: what carries
    /// across episodes whose track order differs.
    static func rememberedAudioKey(_ stream: AudioStreamInfo) -> String {
        let tag = normalizeLangTag(stream.languageTag)
        let channels = stream.channels.map(String.init) ?? ""
        return "\(canonicalLanguage(stream.language) ?? "und"):\(audioRole(stream)):\(channels)" + (tag.isEmpty ? "" : ":" + tag)
    }

    /// Stream a remembered key names: same language (the variant, when some stream has it),
    /// then role, then channel count. Never another language. Bare `language` and
    /// `language:ordinal` keys match too.
    static func rememberedAudioIndex(_ saved: String, in streams: [AudioStreamInfo]) -> Int? {
        let parts = saved.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        let language = canonicalLanguage(parts[0])
        let inLanguage = streams.indices.filter { canonicalLanguage(streams[$0].language) == language }
        guard !inLanguage.isEmpty else { return nil }
        let variant = parts.count > 3 ? normalizeLangTag(parts[3]) : ""
        let sameVariant = variant.isEmpty ? [] : inLanguage.filter { normalizeLangTag(streams[$0].languageTag) == variant }
        let same = sameVariant.isEmpty ? inLanguage : sameVariant
        guard parts.count > 1 else { return same[0] }
        if let ordinal = Int(parts[1]), ordinal >= 0 { return same.indices.contains(ordinal) ? same[ordinal] : same[0] }
        let sameRole = same.filter { audioRole(streams[$0]) == parts[1] }
        let pool = sameRole.isEmpty ? same : sameRole
        let channels = parts.count > 2 ? parts[2] : ""
        return pool.first { (streams[$0].channels.map(String.init) ?? "") == channels } ?? pool[0]
    }

    /// Position in `streams` of the audio track to start with; nil only when there are none.
    /// The remembered pick when it matches, else a main track of the preferred language
    /// (default-flagged first), else the file's default-flagged track in "use default" mode,
    /// else the first.
    static func audioIndex(in streams: [AudioStreamInfo], preferredLanguage: String, useDefault: Bool,
                           remembered: String? = nil) -> Int? {
        guard !streams.isEmpty else { return nil }
        if let remembered, let index = rememberedAudioIndex(remembered, in: streams) { return index }
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
                          forced: $0.forced, hearingImpaired: $0.hearingImpaired, machineMade: false,
                          languageTag: $0.languageTag)
        }
        let sidecars = external.filter(isRenderableTextSidecar).sorted { $0.id < $1.id }
            .map { track($0, id: "ext-\($0.id)") }
        return inContainer + sidecars
    }

    /// Bitmap tracks, embedded or sidecar: never in the `subs` group, shown only by a burn-in.
    static func bitmapSubtitleTracks(_ rows: [SubtitleFileRow]) -> [SubtitleTrack] {
        rows.filter { isImageBasedSubtitleCodec($0.codec ?? "") }.compactMap { row -> SubtitleTrack? in
            var id = "ext-\(row.id)"
            if row.relativePath?.isEmpty ?? true {
                guard let streamIndex = row.streamIndex else { return nil }
                id = "emb-\(streamIndex)"
            }
            var bitmap = track(row, id: id)
            bitmap.burnInId = row.id
            return bitmap
        }
    }

    private static func track(_ row: SubtitleFileRow, id: String) -> SubtitleTrack {
        SubtitleTrack(id: id, language: canonicalLanguage(row.language),
                      forced: row.forced ?? false, hearingImpaired: row.hearingImpaired ?? false,
                      machineMade: row.providerType == "translated" || row.providerType == "ocr")
    }

    /// The remembered form of a pick, `language[:forced][:embedded][:hi][:variant]`
    /// (`variant` is a tag like `pt-PT`, which no flag resembles). Off is `off`.
    static func rememberedSubtitleValue(_ track: SubtitleTrack) -> String {
        let parts: [String?] = [
            track.language ?? "und", track.forced ? "forced" : nil, track.id.hasPrefix("emb-") ? "embedded" : nil,
            track.hearingImpaired ? "hi" : nil, normalizeLangTag(track.languageTag),
        ]
        return parts.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ":")
    }

    /// Track a remembered pick names: language and forced-ness always hold, then the
    /// hearing-impaired and embedded flags are relaxed in turn. The variant wins when
    /// some track has it, else another track of the language stands in.
    static func rememberedSubtitleIndex(_ saved: String, in tracks: [SubtitleTrack]) -> Int? {
        let parts = saved.split(separator: ":").map(String.init)
        guard let head = parts.first else { return nil }
        let language = canonicalLanguage(head)
        let forced = parts.contains("forced"), embedded = parts.contains("embedded"), hi = parts.contains("hi")
        let variant = normalizeLangTag(parts.dropFirst().first { $0.contains("-") || $0.contains("_") })
        let sameKind = tracks.indices.filter { tracks[$0].language == language && tracks[$0].forced == forced }
        func find(_ ok: (Int) -> Bool) -> Int? {
            sameKind.first { ok($0) && tracks[$0].hearingImpaired == hi && tracks[$0].id.hasPrefix("emb-") == embedded }
                ?? sameKind.first { ok($0) && tracks[$0].hearingImpaired == hi }
                ?? sameKind.first(where: ok)
        }
        let withVariant = variant.isEmpty ? nil : find { normalizeLangTag(tracks[$0].languageTag) == variant }
        return withVariant ?? find { _ in true }
    }

    /// What the settings select for an item: nil shows none, never another language.
    /// A remembered pick (`off`, or a track of its language) comes first; then a text track
    /// wins over a bitmap one. `audioLanguage` is canonical, nil when unknown.
    static func autoSubtitle(mode: String, preferredLanguage: String, audioLanguage: String?,
                             text: [SubtitleTrack], bitmap: [SubtitleTrack],
                             remembered: String? = nil) -> SubtitlePick? {
        if let remembered {
            if remembered == "off" { return nil }
            if let index = rememberedSubtitleIndex(remembered, in: text) { return .text(index) }
        }
        guard mode != "off", let wanted = canonicalLanguage(preferredLanguage) else { return nil }
        let forcedOnly = mode == "intelligent" && wanted == audioLanguage
        if let index = pickSubtitle(text, language: wanted, forcedOnly: forcedOnly) { return .text(index) }
        return pickSubtitle(bitmap, language: wanted, forcedOnly: forcedOnly)
            .flatMap { bitmap[$0].burnInId }
            .map(SubtitlePick.burnIn)
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
