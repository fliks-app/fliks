import Foundation

/// Party dates in the app's language (the Display setting), never the device or a fixed English pattern.
enum PartyDate {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var formatters: [String: DateFormatter] = [:]

    static func text(_ date: Date) -> String {
        let lang = LocaleStore.shared.lang
        lock.lock()
        defer { lock.unlock() }
        let formatter = formatters[lang] ?? {
            let f = DateFormatter()
            f.locale = Locale(identifier: lang)
            f.dateStyle = .medium
            f.timeStyle = .short
            formatters[lang] = f
            return f
        }()
        return formatter.string(from: date)
    }
}
