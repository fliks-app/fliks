import Foundation

/// The decrypted notification (`server/docs/spec/push.md`, rule 17).
struct PushMessage: Decodable, Equatable {
    struct Action: Decodable, Equatable {
        let id: String
        let title: String
        let kind: String
        let url: String?
        let token: String?
    }

    /// The plaintext version this build reads; a higher one is shown as the generic text.
    static let version = 1

    let v: Int
    let id: String
    let ts: Double
    let ttl: Double
    let cat: String
    let title: String
    let body: String
    let url: String
    let image: String?
    let actions: [Action]?
    let badge: Int?
    let user: Int
    let tag: String?
}

/// The action sets of the catalogue: one `UNNotificationCategory` each, registered at launch.
enum PushCategories {
    static let sets: [[String]] = [["approve", "decline"], ["accept", "decline"], ["join"]]
    static let opening: Set<String> = ["join"]

    static func identifier(_ ids: [String]) -> String { "fliks." + ids.joined(separator: ".") }
}

enum PushOutcome: Equatable {
    case show(PushMessage, PushSubscription)
    /// A push for a subscription this device does not hold: the relay row is stale.
    case unknown(sub: String)
    /// Shown with the relay's generic text: iOS cannot hide a push without Apple's filtering entitlement.
    case fallback
}

enum PushPipeline {
    /// `subscriptions` is nil while the keychain is unreadable: the generic text, nothing deleted.
    static func evaluate(_ userInfo: [AnyHashable: Any], subscriptions: [PushSubscription]?, seen: [String], now: Date = Date()) -> PushOutcome {
        guard let subscriptions, let key = userInfo["k"] as? String, let sub = userInfo["s"] as? String,
              let payload = userInfo["p"] as? String else { return .fallback }
        guard let record = subscriptions.first(where: { $0.sub == sub }) else { return .unknown(sub: sub) }
        guard record.relayKey == key, let privateKey = record.key,
              let message = Data(base64URL: payload),
              let plain = PushCrypto.decrypt(message, privateKey: privateKey, auth: record.auth),
              let decoded = try? JSONDecoder().decode(PushMessage.self, from: plain), decoded.v <= PushMessage.version,
              decoded.ts + decoded.ttl >= now.timeIntervalSince1970, !seen.contains(decoded.id) else { return .fallback }
        return .show(decoded, record)
    }
}
