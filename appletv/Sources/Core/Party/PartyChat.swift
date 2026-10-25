import Foundation

/// A reaction rising over the video; `left` is its start, as a fraction of the width.
struct FloatingReaction: Identifiable, Equatable {
    let id: Int
    let emoji: String
    let username: String
    let left: Double
}

enum PartyReactions {
    /// Emojis of the default bar when the server's catalog is not available (same as the server's).
    static let fallbackBar = ["\u{1F44D}", "\u{1F602}", "\u{1F62E}", "\u{1F622}", "\u{1F621}", "\u{2764}\u{FE0F}", "\u{1F525}", "\u{1F44F}"]
    /// Reactions on screen at once; the oldest goes first.
    static let maxOnScreen = 12
    static let riseSeconds = 2.0

    static func appending(_ list: [FloatingReaction], _ reaction: FloatingReaction) -> [FloatingReaction] {
        Array((list + [reaction]).suffix(maxOnScreen))
    }
}

extension PartyMessage {
    /// A system message in the viewer's language, or "name: text" for a chat one.
    var line: String {
        guard let system else { return "\(username ?? "")\(tr("party.chat_name_sep"))\(text)" }
        let title = system.args?.title ?? ""
        let kind = system.kind == "item_skipped" && title.isEmpty ? "item_skipped_hidden" : system.kind
        return trp("party.system.\(kind)", [
            "by": system.by ?? system.args?.username ?? "", "title": title,
            "position": system.args?.position.map(Self.clock) ?? "",
        ])
    }

    /// h:mm:ss, or m:ss under an hour.
    static func clock(_ seconds: Double) -> String {
        let total = max(0, Int(seconds))
        let (h, m, s) = (total / 3600, total / 60 % 60, total % 60)
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }
}
