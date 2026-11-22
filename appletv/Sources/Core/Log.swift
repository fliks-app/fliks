import os

/// One `Logger` per area, readable in Console.app and in a sysdiagnose, unlike `print`.
/// Interpolate paths, ids and statuses as `.public`; never a token or a tokenised URL.
enum Log {
    private static let subsystem = "media.fliks.app"

    static let api = Logger(subsystem: subsystem, category: "api")
    static let auth = Logger(subsystem: subsystem, category: "auth")
    static let library = Logger(subsystem: subsystem, category: "library")
    static let music = Logger(subsystem: subsystem, category: "music")
    static let party = Logger(subsystem: subsystem, category: "party")
    static let player = Logger(subsystem: subsystem, category: "player")
    static let remote = Logger(subsystem: subsystem, category: "remote")
    static let zones = Logger(subsystem: subsystem, category: "zones")
}
