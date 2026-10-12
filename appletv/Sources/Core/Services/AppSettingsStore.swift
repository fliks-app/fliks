import Foundation

/// Display/Player/Subtitle preferences, persisted in UserDefaults — the
/// tvOS counterpart of the Angular `DisplaySettingsService` /
/// `PlayerSettingsService`. Desktop-only prefs aren't ported here; this covers the
/// settings the plan calls out, plus the per-media remembered audio/subtitle picks.
@Observable final class AppSettingsStore {
    static let shared = AppSettingsStore()

    private let d = UserDefaults.standard

    // MARK: Display

    /// "" = follow the device language; else en/fr/es/de/it/pt. Read by `LocaleStore`.
    var displayLanguage: String {
        didSet { d.set(displayLanguage, forKey: Keys.displayLanguage) }
    }
    /// Show the page-wide fanart background on the home page.
    var homeBackground: Bool {
        didSet { d.set(homeBackground, forKey: Keys.homeBackground) }
    }

    // MARK: Player

    var preferredAudioLanguage: String {
        didSet { d.set(preferredAudioLanguage, forKey: Keys.preferredAudioLanguage) }
    }
    var useDefaultAudioStream: Bool {
        didSet { d.set(useDefaultAudioStream, forKey: Keys.useDefaultAudioStream) }
    }
    var forceDisableHdr: Bool {
        didSet { d.set(forceDisableHdr, forKey: Keys.forceDisableHdr) }
    }
    /// Show the low-consumption quality rungs in the player quality menu.
    var showEcoQualities: Bool {
        didSet { d.set(showEcoQualities, forKey: Keys.showEcoQualities) }
    }
    /// Only eco rungs offered, one selected by default. Overrides `showEcoQualities`.
    var ecoByDefault: Bool {
        didSet { d.set(ecoByDefault, forKey: Keys.ecoByDefault) }
    }
    /// Last quality picked in the player menu ("auto" or a rung id); sent with the next playback-info.
    var playerQualityId: String {
        didSet { d.set(playerQualityId, forKey: Keys.playerQualityId) }
    }
    var autoSkipIntro: Bool {
        didSet { d.set(autoSkipIntro, forKey: Keys.autoSkipIntro) }
    }
    var autoPlayNext: Bool {
        didSet { d.set(autoPlayNext, forKey: Keys.autoPlayNext) }
    }
    var rememberAudioSelections: Bool {
        didSet { d.set(rememberAudioSelections, forKey: Keys.rememberAudioSelections) }
    }

    // MARK: Subtitles

    var preferredSubtitleLanguage: String {
        didSet { d.set(preferredSubtitleLanguage, forKey: Keys.preferredSubtitleLanguage) }
    }
    /// "off" | "intelligent" | "always"
    var subtitleMode: String {
        didSet { d.set(subtitleMode, forKey: Keys.subtitleMode) }
    }
    var rememberSubtitleSelections: Bool {
        didSet { d.set(rememberSubtitleSelections, forKey: Keys.rememberSubtitleSelections) }
    }

    // MARK: Remembered picks

    /// Per-media pick the viewer made (`lang:role:channels[:variant]`), by media id: a series covers its episodes.
    func rememberedAudio(for mediaId: Int) -> String? {
        rememberAudioSelections ? selections(Keys.audioSelections)[String(mediaId)] : nil
    }

    func rememberAudio(_ value: String, for mediaId: Int) {
        if rememberAudioSelections { store(value, for: mediaId, in: Keys.audioSelections) }
    }

    /// `lang[:forced][:embedded][:image][:hi][:variant]`, or `off`.
    func rememberedSubtitle(for mediaId: Int) -> String? {
        rememberSubtitleSelections ? selections(Keys.subtitleSelections)[String(mediaId)] : nil
    }

    func rememberSubtitle(_ value: String, for mediaId: Int) {
        if rememberSubtitleSelections { store(value, for: mediaId, in: Keys.subtitleSelections) }
    }

    private func selections(_ key: String) -> [String: String] {
        d.dictionary(forKey: key) as? [String: String] ?? [:]
    }

    private func store(_ value: String, for mediaId: Int, in key: String) {
        var map = selections(key)
        map[String(mediaId)] = value
        d.set(map, forKey: key)
    }

    private init() {
        displayLanguage = d.string(forKey: Keys.displayLanguage) ?? ""
        homeBackground = d.object(forKey: Keys.homeBackground) as? Bool ?? true
        preferredAudioLanguage = d.string(forKey: Keys.preferredAudioLanguage) ?? ""
        useDefaultAudioStream = d.bool(forKey: Keys.useDefaultAudioStream)
        forceDisableHdr = d.bool(forKey: Keys.forceDisableHdr)
        showEcoQualities = d.object(forKey: Keys.showEcoQualities) as? Bool ?? true
        ecoByDefault = d.bool(forKey: Keys.ecoByDefault)
        playerQualityId = d.string(forKey: Keys.playerQualityId) ?? "auto"
        autoSkipIntro = d.bool(forKey: Keys.autoSkipIntro)
        autoPlayNext = d.object(forKey: Keys.autoPlayNext) as? Bool ?? true
        rememberAudioSelections = d.object(forKey: Keys.rememberAudioSelections) as? Bool ?? true
        preferredSubtitleLanguage = d.string(forKey: Keys.preferredSubtitleLanguage) ?? ""
        subtitleMode = d.string(forKey: Keys.subtitleMode) ?? "intelligent"
        rememberSubtitleSelections = d.object(forKey: Keys.rememberSubtitleSelections) as? Bool ?? true
        // 10-foot UI: default to large subtitles, matching the web client's isTv() branch.
    }

    private enum Keys {
        static let displayLanguage = "settings.displayLanguage"
        static let homeBackground = "settings.homeBackground"
        static let preferredAudioLanguage = "settings.preferredAudioLanguage"
        static let useDefaultAudioStream = "settings.useDefaultAudioStream"
        static let forceDisableHdr = "settings.forceDisableHdr"
        static let showEcoQualities = "settings.showEcoQualities"
        static let ecoByDefault = "settings.ecoByDefault"
        static let playerQualityId = "settings.playerQualityId"
        static let autoSkipIntro = "settings.autoSkipIntro"
        static let autoPlayNext = "settings.autoPlayNext"
        static let preferredSubtitleLanguage = "settings.preferredSubtitleLanguage"
        static let subtitleMode = "settings.subtitleMode"
        static let rememberAudioSelections = "settings.rememberAudioSelections"
        static let rememberSubtitleSelections = "settings.rememberSubtitleSelections"
        // Same names as the web client's localStorage maps.
        static let audioSelections = "player.audioSelections"
        static let subtitleSelections = "player.subtitleSelections"
    }
}
