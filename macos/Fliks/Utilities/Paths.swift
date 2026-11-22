import Foundation

/// Central path registry — every file-system location the app touches
/// lives here so nothing is scattered across managers.
///
/// External binaries resolve from the bundle resources first, then the
/// Homebrew prefix (`/opt/homebrew`), so development builds (Homebrew
/// installed) and release builds (fully bundled) share the same code;
/// fliks-engine and fliks-server only exist in the bundle.
enum Paths {

    // MARK: - Application Support

    static let appSupport: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        // "Fliks" is the desktop client's userData.
        return base.appendingPathComponent("Fliks Server")
    }()

    /// PostgreSQL data cluster.
    static let pgDataDir  = appSupport.appendingPathComponent("postgresql/data")
    /// PostgreSQL log file.
    static let pgLogFile  = appSupport.appendingPathComponent("postgresql/pg.log")
    /// JWT secret and other auto-generated config (maps to FLIKS_CONF_DIR).
    static let confDir    = appSupport.appendingPathComponent("conf")
    /// Tray-private files, never passed to the server (0700).
    static let privateDir = appSupport.appendingPathComponent("private")
    /// Password of the `fliks` superuser; read by the tray only.
    static let dbAdminPasswordFile = privateDir.appendingPathComponent(".db-admin-password")
    /// Password of the `fliks_app` role, handed to the server.
    static let dbPasswordFile = confDir.appendingPathComponent(".db-password")
    /// App role password not yet in effect (`db-role` ran, `.db-password` not replaced).
    static let dbPasswordNextFile = confDir.appendingPathComponent(".db-password.next")
    /// Working directory of the server — `images/` and `backups/` of
    /// existing installs live here.
    static let dataDir    = appSupport.appendingPathComponent("data")
    /// Application logs.
    static let logsDir    = appSupport.appendingPathComponent("logs")

    // MARK: - Bundle Resources

    private static let resources: URL = {
        Bundle.main.resourceURL ?? URL(fileURLWithPath: "/dev/null")
    }()

    // MARK: - Engine and server

    /// Supervisor shipped beside fliks-server in `bin/` (nil only when it is missing).
    static let engineBinary: URL? = {
        let bundled = resources.appendingPathComponent("bin/fliks-engine")
        return isExecutable(bundled) ? bundled : nil
    }()

    /// Server binary shipped in `bin/` (nil only when it is missing).
    static let serverBinary: URL? = engineBinary?.deletingLastPathComponent().appendingPathComponent("fliks-server")

    // MARK: - PostgreSQL

    /// PostgreSQL binaries directory.
    static let pgBinDir: URL = {
        let bundled = resources.appendingPathComponent("postgres/bin")
        if isExecutable(bundled.appendingPathComponent("postgres")) { return bundled }
        let brew = URL(fileURLWithPath: "/opt/homebrew/opt/postgresql@18/bin")
        if isExecutable(brew.appendingPathComponent("postgres")) { return brew }
        return bundled
    }()

    /// PostgreSQL shared libraries.
    static let pgLibDir: URL = {
        let bundled = resources.appendingPathComponent("postgres/lib")
        if FileManager.default.fileExists(atPath: bundled.path) { return bundled }
        return URL(fileURLWithPath: "/opt/homebrew/opt/postgresql@18/lib")
    }()

    /// PostgreSQL share directory (timezones, SQL scripts, etc.).
    static let pgShareDir: URL = {
        let bundled = resources.appendingPathComponent("postgres/share")
        if FileManager.default.fileExists(atPath: bundled.path) { return bundled }
        return URL(fileURLWithPath: "/opt/homebrew/opt/postgresql@18/share")
    }()

    // MARK: - Tools pack

    /// ffmpeg (VideoToolbox), ffprobe, fpcalc, mkvmerge from the engine's tools pack.
    static let toolsDir: URL = {
        let bundled = resources.appendingPathComponent("tools")
        if isExecutable(bundled.appendingPathComponent("ffmpeg")) { return bundled }
        let brew = URL(fileURLWithPath: "/opt/homebrew/bin")
        if isExecutable(brew.appendingPathComponent("ffmpeg")) { return brew }
        return bundled
    }()

    // MARK: - Client

    /// Built Angular client.
    static let clientDir         = resources.appendingPathComponent("client")
    /// Public assets (emoji), FLIKS_CAST_DIR.
    static let castDir           = resources.appendingPathComponent("cast")

    // MARK: - Development fallbacks

    /// When running from Xcode (no bundled resources), resolve paths
    /// relative to the repo root.
    static let repoRoot: URL? = {
        // In debug builds, use compile-time source path to find the repo.
        // Paths.swift lives at macos/Fliks/Utilities/Paths.swift — repo is 4 levels up.
        #if DEBUG
        var sourceDir = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 {
            sourceDir = sourceDir.deletingLastPathComponent()
        }
        if FileManager.default.fileExists(atPath: sourceDir.appendingPathComponent("server/Cargo.toml").path) {
            return sourceDir
        }
        #endif
        // Production: climb from the executable
        var dir = URL(fileURLWithPath: ProcessInfo.processInfo.arguments[0])
            .deletingLastPathComponent()
        for _ in 0..<10 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent("server/Cargo.toml").path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        return nil
    }()

    static let effectiveCastDir: URL = {
        if FileManager.default.fileExists(atPath: castDir.path) { return castDir }
        return repoRoot?.appendingPathComponent("server/public") ?? castDir
    }()

    static let effectiveClientDir: URL = {
        if FileManager.default.fileExists(atPath: clientDir.path) { return clientDir }
        return repoRoot?.appendingPathComponent("client/dist/client/browser") ?? clientDir
    }()

    // MARK: - Helpers

    /// Ensure a directory exists, creating it (and parents) if needed.
    static func ensureDirectory(_ url: URL) throws {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }

    /// Create all required Application Support subdirectories on first launch.
    static func ensureAppSupportStructure() throws {
        for dir in [appSupport, pgDataDir.deletingLastPathComponent(), confDir, privateDir, dataDir, logsDir] {
            try ensureDirectory(dir)
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: privateDir.path)
    }

    /// Delete `*.log` files of `logsDir` not written for `days` days (server, Postgres).
    static func pruneLogs(keepingDays days: Int = 14) {
        let fm = FileManager.default
        let cutoff = Date().addingTimeInterval(-Double(days) * 86_400)
        let files = (try? fm.contentsOfDirectory(at: logsDir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        for file in files where file.pathExtension == "log" {
            let modified = try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
            if let modified, modified < cutoff { try? fm.removeItem(at: file) }
        }
    }

    private static func isExecutable(_ url: URL) -> Bool {
        FileManager.default.isExecutableFile(atPath: url.path)
    }
}
