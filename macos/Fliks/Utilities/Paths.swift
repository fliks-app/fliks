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
        return base.appendingPathComponent("Fliks")
    }()

    /// PostgreSQL data cluster.
    static let pgDataDir  = appSupport.appendingPathComponent("postgresql/data")
    /// PostgreSQL log file.
    static let pgLogFile  = appSupport.appendingPathComponent("postgresql/pg.log")
    /// JWT secret and other auto-generated config (maps to FLIKS_CONF_DIR).
    static let confDir    = appSupport.appendingPathComponent("conf")
    /// Working directory for the Node process — `images/`, `backups/`,
    /// `thumbnails/` are created here by the backend.
    static let dataDir    = appSupport.appendingPathComponent("data")
    /// Application logs.
    static let logsDir    = appSupport.appendingPathComponent("logs")

    // MARK: - Bundle Resources

    private static let resources: URL = {
        Bundle.main.resourceURL ?? URL(fileURLWithPath: "/dev/null")
    }()

    // MARK: - Node.js

    /// Node.js binary — bundle first, then Vendored (dev), then Homebrew, then system.
    static let nodeBinary: URL = {
        let bundled = resources.appendingPathComponent("node/bin/node")
        if isExecutable(bundled) { return bundled }
        // Dev: Vendored dir next to the Xcode project
        if let repo = repoRoot {
            let vendored = repo.appendingPathComponent("macos/Vendored/node/bin/node")
            if isExecutable(vendored) { return vendored }
        }
        // Homebrew node (may be node@24, node@22, or just node)
        for name in ["node@24", "node@22", "node"] {
            let brew = URL(fileURLWithPath: "/opt/homebrew/opt/\(name)/bin/node")
            if isExecutable(brew) { return brew }
        }
        // System PATH fallback
        if let sys = findInPath("node") { return sys }
        return bundled // will fail at runtime with a clear error
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

    // MARK: - Backend & Client

    /// Built NestJS backend (dist/, node_modules/, package.json).
    static let backendDir        = resources.appendingPathComponent("backend")
    static let backendDist       = resources.appendingPathComponent("backend/dist")
    static let backendModules    = resources.appendingPathComponent("backend/node_modules")
    static let backendPackageJSON = resources.appendingPathComponent("backend/package.json")
    /// Built Angular client.
    static let clientDir         = resources.appendingPathComponent("client")

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
        if FileManager.default.fileExists(atPath: sourceDir.appendingPathComponent("backend/package.json").path) {
            return sourceDir
        }
        #endif
        // Production: climb from the executable
        var dir = URL(fileURLWithPath: ProcessInfo.processInfo.arguments[0])
            .deletingLastPathComponent()
        for _ in 0..<10 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent("backend/package.json").path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        return nil
    }()

    /// Backend dist (development: from repo, production: from bundle).
    static let effectiveBackendDist: URL = {
        if FileManager.default.fileExists(atPath: backendDist.path) { return backendDist }
        return repoRoot?.appendingPathComponent("backend/dist") ?? backendDist
    }()

    static let effectiveBackendModules: URL = {
        if FileManager.default.fileExists(atPath: backendModules.path) { return backendModules }
        return repoRoot?.appendingPathComponent("backend/node_modules") ?? backendModules
    }()

    static let effectiveBackendPackageJSON: URL = {
        if FileManager.default.fileExists(atPath: backendPackageJSON.path) { return backendPackageJSON }
        return repoRoot?.appendingPathComponent("backend/package.json") ?? backendPackageJSON
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
