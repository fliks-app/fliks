import Foundation

/// Central path registry — every file-system location the app touches
/// lives here so nothing is scattered across managers.
///
/// Resolution order for external binaries: bundle resources first,
/// then Homebrew prefix (`/opt/homebrew`), then system PATH.
/// This allows development builds (Homebrew-installed) and release
/// builds (fully bundled) to share the same code.
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

    // MARK: - FFmpeg

    /// FFmpeg binary with VideoToolbox support.
    static let ffmpegDir: URL = {
        let bundled = resources.appendingPathComponent("ffmpeg/bin")
        if isExecutable(bundled.appendingPathComponent("ffmpeg")) { return bundled }
        let brew = URL(fileURLWithPath: "/opt/homebrew/bin")
        if isExecutable(brew.appendingPathComponent("ffmpeg")) { return brew }
        return bundled
    }()

    // MARK: - Client

    /// Built Angular client.
    static let clientDir         = resources.appendingPathComponent("client")
    /// Cast receiver page, served at /cast (FLIKS_CAST_DIR).
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
        for dir in [appSupport, pgDataDir.deletingLastPathComponent(), confDir, dataDir, logsDir] {
            try ensureDirectory(dir)
        }
    }

    private static func isExecutable(_ url: URL) -> Bool {
        FileManager.default.isExecutableFile(atPath: url.path)
    }

    private static func findInPath(_ name: String) -> URL? {
        guard let pathEnv = ProcessInfo.processInfo.environment["PATH"] else { return nil }
        for dir in pathEnv.split(separator: ":") {
            let candidate = URL(fileURLWithPath: String(dir)).appendingPathComponent(name)
            if isExecutable(candidate) { return candidate }
        }
        return nil
    }
}
