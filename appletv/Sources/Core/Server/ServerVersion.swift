import Foundation

/// Version of the connected server, for features added after the oldest server the app supports.
@MainActor
@Observable final class ServerVersion {
    static let shared = ServerVersion()

    private(set) var value: String?

    private init() {}

    func refresh() async {
        struct Reply: Decodable { let version: String }
        let reply: Reply? = try? await APIClient.shared.get("/api/system/version")
        // A failed fetch keeps the last known version: nil would hide every 5.2 feature until the next success.
        if let reply { value = reply.version }
    }

    /// A `-dev` server runs the newest code; an unknown version supports nothing new.
    func supports(_ since: String) -> Bool {
        guard let value else { return false }
        return value.hasSuffix("-dev") || !Self.isNewer(since, than: value)
    }

    /// Numeric x.y.z compare, pre-release and build suffix dropped.
    nonisolated static func isNewer(_ a: String, than b: String) -> Bool {
        func parts(_ v: String) -> [Int]? {
            let core = v.trimmingCharacters(in: .whitespaces).drop { $0 == "v" || $0 == "V" }
                .split { $0 == "-" || $0 == "+" }.first ?? ""
            let nums = core.split(separator: ".").map { Int($0) }
            return nums.contains(nil) ? nil : nums.compactMap { $0 }
        }
        guard let x = parts(a), let y = parts(b) else { return false }
        for i in 0..<max(x.count, y.count) {
            let (p, q) = (i < x.count ? x[i] : 0, i < y.count ? y[i] : 0)
            if p != q { return p > q }
        }
        return false
    }
}
