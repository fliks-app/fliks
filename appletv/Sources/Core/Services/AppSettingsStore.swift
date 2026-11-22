import Foundation

/// Display/Player/Subtitle preferences, persisted in UserDefaults — the
/// tvOS counterpart of the Angular `DisplaySettingsService` /
/// `PlayerSettingsService`. Desktop-only prefs aren't ported here; this covers the
/// settings the plan calls out, plus the per-media remembered audio/subtitle picks.
///
/// Everything but the display language is kept per (server, account): `rescope()` reloads it when the
/// signed-in account changes. A value the account never saved falls back to the unscoped key.
@Observable final class AppSettingsStore {
    static let shared = AppSettingsStore()

    @ObservationIgnored private let d = UserDefaults.standard
    @ObservationIgnored private var loading = false

    // MARK: Display

    /// "" = follow the device language; else en/fr/es/de/it/pt. Read by `LocaleStore`.
    var displayLanguage: String = "" {
        didSet { d.set(displayLanguage, forKey: Keys.displayLanguage) }
    }
    /// Show the page-wide fanart background on the home page.
    var homeBackground: Bool = true {
        didSet { save(homeBackground, Keys.homeBackground) }
    }

    // MARK: Player

    var preferredAudioLanguage: String = "" {
        didSet { save(preferredAudioLanguage, Keys.preferredAudioLanguage) }
    }
    var useDefaultAudioStream: Bool = false {
        didSet { save(useDefaultAudioStream, Keys.useDefaultAudioStream) }
    }
    var forceDisableHdr: Bool = false {
        didSet { save(forceDisableHdr, Keys.forceDisableHdr) }
    }
    /// Show the low-consumption quality rungs in the player quality menu.
    var showEcoQualities: Bool = true {
        didSet { save(showEcoQualities, Keys.showEcoQualities) }
    }
    /// Only eco rungs offered, one selected by default. Overrides `showEcoQualities`.
    var ecoByDefault: Bool = false {
        didSet { save(ecoByDefault, Keys.ecoByDefault) }
    }
    /// Last quality picked in the player menu ("auto" or a rung id); sent with the next playback-info.
    var playerQualityId: String = "auto" {
        didSet { save(playerQualityId, Keys.playerQualityId) }
    }
    var autoSkipIntro: Bool = false {
        didSet { save(autoSkipIntro, Keys.autoSkipIntro) }
    }
    var autoPlayNext: Bool = true {
        didSet { save(autoPlayNext, Keys.autoPlayNext) }
    }
    var rememberAudioSelections: Bool = true {
        didSet { save(rememberAudioSelections, Keys.rememberAudioSelections) }
    }

    // MARK: Subtitles

    var preferredSubtitleLanguage: String = "" {
        didSet { save(preferredSubtitleLanguage, Keys.preferredSubtitleLanguage) }
    }
    /// "off" | "intelligent" | "always"
    var subtitleMode: String = "intelligent" {
        didSet { save(subtitleMode, Keys.subtitleMode) }
    }
    var rememberSubtitleSelections: Bool = true {
        didSet { save(rememberSubtitleSelections, Keys.rememberSubtitleSelections) }
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

    private func selections(_ base: String) -> [String: String] {
        (d.dictionary(forKey: Self.scoped(base)) ?? d.dictionary(forKey: base)) as? [String: String] ?? [:]
    }

    private func store(_ value: String, for mediaId: Int, in base: String) {
        var map = selections(base)
        map[String(mediaId)] = value
        d.set(map, forKey: Self.scoped(base))
    }

    /// Key of a per-account preference, the unscoped one when nobody is signed in.
    static func scoped(_ base: String) -> String {
        AuthService.shared.scope.map { "\($0)#\(base)" } ?? base
    }

    private func save(_ value: Any, _ base: String) {
        guard !loading else { return }
        d.set(value, forKey: Self.scoped(base))
    }

    private func read(_ base: String) -> Any? {
        d.object(forKey: Self.scoped(base)) ?? d.object(forKey: base)
    }

    /// Reloads the per-account preferences for the account now signed in.
    func rescope() { load() }

    private func load() {
        loading = true
        defer { loading = false }
        displayLanguage = d.string(forKey: Keys.displayLanguage) ?? ""
        homeBackground = read(Keys.homeBackground) as? Bool ?? true
        preferredAudioLanguage = read(Keys.preferredAudioLanguage) as? String ?? ""
        useDefaultAudioStream = read(Keys.useDefaultAudioStream) as? Bool ?? false
        forceDisableHdr = read(Keys.forceDisableHdr) as? Bool ?? false
        showEcoQualities = read(Keys.showEcoQualities) as? Bool ?? true
        ecoByDefault = read(Keys.ecoByDefault) as? Bool ?? false
        playerQualityId = read(Keys.playerQualityId) as? String ?? "auto"
        autoSkipIntro = read(Keys.autoSkipIntro) as? Bool ?? false
        autoPlayNext = read(Keys.autoPlayNext) as? Bool ?? true
        rememberAudioSelections = read(Keys.rememberAudioSelections) as? Bool ?? true
        preferredSubtitleLanguage = read(Keys.preferredSubtitleLanguage) as? String ?? ""
        subtitleMode = read(Keys.subtitleMode) as? String ?? "intelligent"
        rememberSubtitleSelections = read(Keys.rememberSubtitleSelections) as? Bool ?? true
    }

    private init() { load() }

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
