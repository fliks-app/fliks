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

extension PartyMessage.System {
    /// The `party.system.*` key and its params, mirroring the web client's `systemText`.
    var text: (key: String, params: [String: String]) {
        let a = args
        let title = a?.title ?? ""
        var params: [String: String] = ["by": by ?? a?.username ?? "", "title": title]
        params["name"] = a?.name ?? ""
        params["added"] = a?.added.map(String.init) ?? ""
        params["removed"] = a?.removed.map(String.init) ?? ""
        params["position"] = a?.position.map(PartyMessage.clock) ?? ""
        params["when"] = a?.scheduledAt.map(PartyDate.text) ?? ""
        params["names"] = a?.usernames?.joined(separator: ", ") ?? ""
        var variant = kind
        switch kind {
        case "setting_changed":
            let value = a?.value == "true" ? "on" : a?.value == "false" ? "off" : a?.value ?? ""
            variant = "setting_\(a?.setting ?? "")_\(value)"
        case "voted":
            variant = a?.value == "1" ? "voted_up" : "voted_down"
        case "proposed" where (a?.count ?? 0) > 1:
            variant = "proposed_many"
            params["count"] = String(a?.count ?? 0)
        case "programme_changed":
            var parts: [String] = []
            if (a?.added ?? 0) > 0 { parts.append("added") }
            if (a?.removed ?? 0) > 0 { parts.append("removed") }
            if !parts.isEmpty { variant = "programme_changed_\(parts.joined(separator: "_"))" }
        default: break
        }
        // A title present but empty means the viewer cannot open the media.
        let hidden = a?.title != nil && title.isEmpty && variant != "proposed_many"
        return ("party.system.\(hidden ? "\(kind)_hidden" : variant)", params)
    }
}

extension PartyMessage {
    /// "name: text", the chat form of a message.
    var chatLine: String { "\(username ?? "")\(tr("party.chat_name_sep"))\(text)" }

    /// A system message in the viewer's language, or the chat line.
    var line: String {
        guard let system else { return chatLine }
        let (key, params) = system.text
        return trp(key, params)
    }

    /// h:mm:ss, or m:ss under an hour.
    static func clock(_ seconds: Double) -> String {
        let total = max(0, Int(seconds))
        let (h, m, s) = (total / 3600, total / 60 % 60, total % 60)
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }
}
