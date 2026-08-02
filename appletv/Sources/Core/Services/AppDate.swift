import Foundation

/// Dates arrive as plain `YYYY-MM-DD` (air dates, calendar) or as ISO
/// timestamps, and are rendered in the app's language — which is the Display
/// setting, not the device locale. Unparseable input is passed through.
@MainActor
enum AppDate {
    /// Numeric, locale-ordered: 02/08/2026 (fr), 08/02/2026 (en), 02.08.2026 (de).
    static func short(_ raw: String?) -> String? { format(raw, .short) }

    /// Spelled-out month: 2 août 2026 (fr), Aug 2, 2026 (en).
    static func medium(_ raw: String?) -> String? { format(raw, .medium) }

    private enum Style: String { case short, medium }

    private static var formatters: [String: DateFormatter] = [:]

    private static func format(_ raw: String?, _ style: Style) -> String? {
        guard let raw, let date = parse(raw) else { return raw }
        return formatter(style).string(from: date)
    }

    private static func formatter(_ style: Style) -> DateFormatter {
        let lang = LocaleStore.shared.lang
        let key = "\(lang)|\(style.rawValue)"
        if let cached = formatters[key] { return cached }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: lang)
        switch style {
        case .short:
            formatter.setLocalizedDateFormatFromTemplate("ddMMyyyy")
        case .medium:
            formatter.dateStyle = .medium
            formatter.timeStyle = .none
        }
        formatters[key] = formatter
        return formatter
    }

    private static let dayOnly: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter
    }()

    private static func parse(_ raw: String) -> Date? {
        dayOnly.date(from: raw)
            ?? ISO8601DateFormatter.withFraction.date(from: raw)
            ?? ISO8601DateFormatter().date(from: raw)
    }
}

private extension ISO8601DateFormatter {
    static let withFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
