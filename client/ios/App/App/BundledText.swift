import Foundation

/// The app's own translations (`public/i18n`): the first system language the app ships, else English,
/// as the web layer picks when no language is set in its settings. Keys are dotted paths.
enum BundledText {
    private static let root: [String: Any] = {
        let codes = Locale.preferredLanguages.compactMap { tag in
            tag.lowercased().split(whereSeparator: { $0 == "-" || $0 == "_" }).first.map(String.init)
        } + ["en"]
        guard let url = codes.lazy.compactMap({ Bundle.main.url(forResource: $0, withExtension: "json", subdirectory: "public/i18n") }).first,
              let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return json
    }()

    static subscript(_ path: String) -> String? {
        path.split(separator: ".").reduce(root as Any?) { ($0 as? [String: Any])?[String($1)] } as? String
    }
}
