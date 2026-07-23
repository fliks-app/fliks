import Foundation

/// What the "recently added" zones rank by — matches the backend's
/// `RecentlyAddedMode` (recently-added.dto.ts).
enum RecentlyAddedMode: String, Codable {
    case media, file, both
}

/// One entry in the saved zone order: a stable key + visibility.
/// `library-recent:<id>` keys are opt-in per-library "recently added" rows.
struct HomeSectionPref: Codable, Equatable {
    var key: String
    var visible: Bool
}

struct HomeSettings: Codable {
    var order: [HomeSectionPref]
    var recentlyAddedMode: RecentlyAddedMode
}

enum HomeSectionType: String {
    case receivedRecommendations = "received-recommendations"
    case libraries
    case continueWatching = "continue-watching"
    case recommendations
    case likes
    case recentlyAdded = "recently-added"
    case playlists
    case comingSoon = "coming-soon"
    case requestsRecent = "requests-recent"
    case libraryRecent = "library-recent"
}

struct ResolvedHomeSection: Identifiable {
    let key: String
    let type: HomeSectionType
    let visible: Bool
    var libraryId: Int?
    var libraryName: String?
    var id: String { key }
}

/// Per-user, per-device home personalization (zone visibility + order and
/// the "recently added" ranking mode), persisted to UserDefaults — the
/// tvOS counterpart of the Angular `HomeSettingsService`. No backend
/// involvement, same as the web client.
@Observable final class HomeSettingsStore {
    static let shared = HomeSettingsStore()

    private static let storageKey = "home.settings"
    private static let libraryRecentPrefix = "library-recent:"
    private static let builtinOrder = [
        "received-recommendations", "libraries", "continue-watching",
        "recommendations", "likes", "recently-added", "playlists", "coming-soon",
    ]
    private static let defaultSettings = HomeSettings(
        order: builtinOrder.map { HomeSectionPref(key: $0, visible: true) },
        recentlyAddedMode: .file
    )

    var settings: HomeSettings {
        didSet { persist() }
    }

    private init() {
        if let data = UserDefaults.standard.data(forKey: Self.storageKey),
           let decoded = try? JSONDecoder().decode(HomeSettings.self, from: data) {
            settings = decoded
        } else {
            settings = Self.defaultSettings
        }
    }

    func setOrder(_ order: [HomeSectionPref]) {
        settings.order = order
    }

    func setMode(_ mode: RecentlyAddedMode) {
        settings.recentlyAddedMode = mode
    }

    /// Reset zone order + visibility to defaults; leaves the ranking mode untouched.
    func resetLayout() {
        settings.order = Self.defaultSettings.order
    }

    /// Reconcile the saved order with what's actually available now: keep
    /// the saved order for still-present zones, append any missing
    /// built-ins (default visible) in their canonical position, add one
    /// zone per library (default hidden — opt-in), and drop entries for
    /// libraries that no longer exist.
    func resolve(libraries: [Library], requestsAllowed: Bool) -> [ResolvedHomeSection] {
        let libName = Dictionary(uniqueKeysWithValues: libraries.map { ($0.id, $0.name) })
        var available = Set(Self.builtinOrder)
        if requestsAllowed { available.insert("requests-recent") }
        for lib in libraries { available.insert("\(Self.libraryRecentPrefix)\(lib.id)") }

        var seen = Set<String>()
        var merged: [HomeSectionPref] = []
        for pref in settings.order where available.contains(pref.key) && !seen.contains(pref.key) {
            merged.append(pref)
            seen.insert(pref.key)
        }
        // Saved layouts predating this zone get it on top, not appended at the bottom.
        if !seen.contains("received-recommendations") {
            merged.insert(HomeSectionPref(key: "received-recommendations", visible: true), at: 0)
            seen.insert("received-recommendations")
        }
        for key in Self.builtinOrder where !seen.contains(key) {
            merged.append(HomeSectionPref(key: key, visible: true))
            seen.insert(key)
        }
        // Permission-gated built-in: only offered when the user can use requests.
        // With no saved preference it defaults visible, slotted just above
        // "recently-added"; a saved order (handled above) wins.
        if requestsAllowed && !seen.contains("requests-recent") {
            let pref = HomeSectionPref(key: "requests-recent", visible: true)
            if let at = merged.firstIndex(where: { $0.key == "recently-added" }) {
                merged.insert(pref, at: at)
            } else {
                merged.append(pref)
            }
            seen.insert("requests-recent")
        }
        for lib in libraries {
            let key = "\(Self.libraryRecentPrefix)\(lib.id)"
            if !seen.contains(key) {
                merged.append(HomeSectionPref(key: key, visible: false))
                seen.insert(key)
            }
        }

        return merged.map { describe($0, libName: libName) }
    }

    private func describe(_ pref: HomeSectionPref, libName: [Int: String]) -> ResolvedHomeSection {
        if pref.key.hasPrefix(Self.libraryRecentPrefix) {
            let libraryId = Int(pref.key.dropFirst(Self.libraryRecentPrefix.count))
            return ResolvedHomeSection(key: pref.key, type: .libraryRecent, visible: pref.visible,
                                        libraryId: libraryId, libraryName: libraryId.flatMap { libName[$0] })
        }
        let type = HomeSectionType(rawValue: pref.key) ?? .recentlyAdded
        return ResolvedHomeSection(key: pref.key, type: type, visible: pref.visible)
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(settings) {
            UserDefaults.standard.set(data, forKey: Self.storageKey)
        }
    }
}
