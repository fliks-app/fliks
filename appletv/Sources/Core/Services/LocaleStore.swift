import Foundation

/// Resolves the active UI language and looks strings up in the bundled client
/// translations (`i18n/`), overridden by the tvOS overlay (`i18n-overlay/`).
/// The actual preference lives on `AppSettingsStore.displayLanguage` (single
/// source of truth) — this is a read-only presentation layer on top of it.
@Observable final class LocaleStore {
    static let shared = LocaleStore()

    static let supportedCodes = ["en", "fr", "es", "de", "it", "pt"]

    /// The Display-settings override, else the first supported device
    /// language, else English.
    var lang: String {
        let override = AppSettingsStore.shared.displayLanguage
        if Self.supportedCodes.contains(override) { return override }
        for tag in Locale.preferredLanguages {
            let code = String(tag.prefix(2))
            if Self.supportedCodes.contains(code) { return code }
        }
        return "en"
    }

    private init() {}

    func string(_ key: String) -> String {
        Self.tables[lang]?[key] ?? Self.tables["en"]?[key] ?? key
    }

    private static let tables: [String: [String: String]] = Dictionary(
        uniqueKeysWithValues: supportedCodes.map { code in
            (code, load("i18n", code).merging(load("i18n-overlay", code)) { _, overlay in overlay })
        })

    /// A bundled translation file flattened to dotted keys (the client files are nested).
    private static func load(_ folder: String, _ code: String) -> [String: String] {
        guard let url = Bundle.main.url(forResource: code, withExtension: "json", subdirectory: folder),
              let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        var out: [String: String] = [:]
        func walk(_ node: [String: Any], _ prefix: String) {
            for (key, value) in node {
                if let child = value as? [String: Any] { walk(child, prefix + key + ".") }
                else if let text = value as? String { out[prefix + key] = text }
            }
        }
        walk(json, "")
        return out
    }
}

/// Localized lookup for the current language (English fallback).
func tr(_ key: String) -> String { LocaleStore.shared.string(key) }

func tr(_ key: String, _ args: CVarArg...) -> String {
    String(format: LocaleStore.shared.string(key), arguments: args)
}

/// Localized lookup for the client's `{{name}}` placeholders.
func trp(_ key: String, _ args: [String: String]) -> String {
    args.reduce(tr(key)) { $0.replacingOccurrences(of: "{{\($1.key)}}", with: $1.value) }
}
