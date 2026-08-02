import Foundation

/// Display/Player/Subtitle preferences, persisted in UserDefaults — the
/// tvOS counterpart of the Angular `DisplaySettingsService` /
/// `PlayerSettingsService`. Per-media "remembered track" maps and desktop-only
/// prefs aren't ported here; this covers the settings the plan calls out.
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
    var autoSkipIntro: Bool {
        didSet { d.set(autoSkipIntro, forKey: Keys.autoSkipIntro) }
    }
    var autoPlayNext: Bool {
        didSet { d.set(autoPlayNext, forKey: Keys.autoPlayNext) }
    }

    // MARK: Subtitles

    var preferredSubtitleLanguage: String {
        didSet { d.set(preferredSubtitleLanguage, forKey: Keys.preferredSubtitleLanguage) }
    }
    /// "off" | "intelligent" | "always"
    var subtitleMode: String {
        didSet { d.set(subtitleMode, forKey: Keys.subtitleMode) }
    }

    private init() {
        displayLanguage = d.string(forKey: Keys.displayLanguage) ?? ""
        homeBackground = d.object(forKey: Keys.homeBackground) as? Bool ?? true
        preferredAudioLanguage = d.string(forKey: Keys.preferredAudioLanguage) ?? ""
        useDefaultAudioStream = d.bool(forKey: Keys.useDefaultAudioStream)
        forceDisableHdr = d.bool(forKey: Keys.forceDisableHdr)
        showEcoQualities = d.object(forKey: Keys.showEcoQualities) as? Bool ?? true
        ecoByDefault = d.bool(forKey: Keys.ecoByDefault)
        autoSkipIntro = d.bool(forKey: Keys.autoSkipIntro)
        autoPlayNext = d.object(forKey: Keys.autoPlayNext) as? Bool ?? true
        preferredSubtitleLanguage = d.string(forKey: Keys.preferredSubtitleLanguage) ?? ""
        subtitleMode = d.string(forKey: Keys.subtitleMode) ?? "intelligent"
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
        static let autoSkipIntro = "settings.autoSkipIntro"
        static let autoPlayNext = "settings.autoPlayNext"
        static let preferredSubtitleLanguage = "settings.preferredSubtitleLanguage"
        static let subtitleMode = "settings.subtitleMode"
    }
}
