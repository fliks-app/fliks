import Foundation
import os

/// Manages the embedded PostgreSQL 18 lifecycle: init, start, stop,
/// health checks, and database creation.
///
/// All pg binaries need `DYLD_LIBRARY_PATH` pointing at the bundled
/// `postgres/lib/` so they can find libpq, libpgtypes, etc.
actor PostgresManager {

    private let logger = Logger(subsystem: "app.fliks.macos", category: "Postgres")

    private let binDir: URL
    private let libDir: URL
    private let shareDir: URL
    private let dataDir: URL
    private let logFile: URL
    private let port: UInt16

    /// Common environment variables injected into every pg command.
    /// Includes Homebrew lib dirs for transitive dependencies (libintl, libicu, etc.).
    private var pgEnv: [String: String] {
        let brewLib = "/opt/homebrew/lib"
        return [
            "DYLD_LIBRARY_PATH": "\(libDir.path):\(brewLib)",
            "DYLD_FALLBACK_LIBRARY_PATH": "\(libDir.path):\(brewLib)",
            "LC_ALL": "C",
        ]
    }

    init(port: UInt16 = 5433) {
        self.binDir   = Paths.pgBinDir
        self.libDir   = Paths.pgLibDir
        self.shareDir = Paths.pgShareDir
        self.dataDir  = Paths.pgDataDir
        self.logFile  = Paths.pgLogFile
        self.port     = port
    }

    // MARK: - Public API

    /// First-launch initialization: runs `initdb` if the data directory
    /// doesn't contain a `PG_VERSION` file yet.
    func initialize() async throws {
        let pgVersion = dataDir.appendingPathComponent("PG_VERSION")
        guard !FileManager.default.fileExists(atPath: pgVersion.path) else {
            logger.info("PostgreSQL data directory already initialized")
            return
        }

        logger.info("Running initdb...")
        try Paths.ensureDirectory(dataDir)

        // Set data dir permissions to 0700 (required by initdb).
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: dataDir.path
        )

        var env = pgEnv
        env["PGDATA"] = dataDir.path

        let result = try await ProcessRunner.run(
            executable: binDir.appendingPathComponent("initdb"),
            arguments: [
                "-D", dataDir.path,
                "--auth=trust",
                "--username=fliks",
                "--encoding=UTF-8",
                "--locale=C",
                "--pgdata=\(dataDir.path)",
            ],
            environment: env,
            timeout: 60
        )

        guard result.succeeded else {
            throw PostgresError.initFailed(result.stderr)
        }

        // Tune postgresql.conf for embedded usage.
        try tweakConfig()
        logger.info("PostgreSQL initialized successfully")
    }

    /// Start the PostgreSQL server and wait until it accepts connections.
    func start() async throws {
        logger.info("Starting PostgreSQL on port \(self.port)...")

        let result = try await ProcessRunner.run(
            executable: binDir.appendingPathComponent("pg_ctl"),
            arguments: [
                "-D", dataDir.path,
                "-l", logFile.path,
                // Single-quote the path: postgres word-splits pg_ctl's -o
                // string, so a bundle path containing a space must be quoted to
                // survive as a single argument. -D and env vars are passed as
                // whole args and don't need this.
                "-o", "-p \(port) -c dynamic_library_path='\(libDir.appendingPathComponent("postgresql").path)'",
                "start",
            ],
            environment: pgEnv,
            timeout: 30
        )

        guard result.succeeded else {
            throw PostgresError.startFailed(result.stderr)
        }

        // Poll pg_isready until the server is accepting connections.
        try await waitForReady(timeout: 30)
        logger.info("PostgreSQL is ready")
    }

    /// Create the `fliks` database if it doesn't exist yet.
    func createDatabaseIfNeeded() async throws {
        logger.info("Ensuring 'fliks' database exists...")

        // Check if database exists first to avoid ERROR log on restarts.
        let check = try await ProcessRunner.run(
            executable: binDir.appendingPathComponent("psql"),
            arguments: [
                "-h", "localhost",
                "-p", String(port),
                "-U", "fliks",
                "-d", "postgres",
                "-tAc", "SELECT 1 FROM pg_database WHERE datname = 'fliks'",
            ],
            environment: pgEnv,
            timeout: 10
        )

        if check.stdout.trimmingCharacters(in: .whitespacesAndNewlines) != "1" {
            let result = try await ProcessRunner.run(
                executable: binDir.appendingPathComponent("createdb"),
                arguments: [
                    "-h", "localhost",
                    "-p", String(port),
                    "-U", "fliks",
                    "fliks",
                ],
                environment: pgEnv,
                timeout: 10
            )

            if !result.succeeded {
                throw PostgresError.createDBFailed(result.stderr)
            }
        }

        // Ensure pg_trgm extension (the backend also does this, but belt-and-suspenders).
        let extResult = try await ProcessRunner.run(
            executable: binDir.appendingPathComponent("psql"),
            arguments: [
                "-h", "localhost",
                "-p", String(port),
                "-U", "fliks",
                "-d", "fliks",
                "-c", "CREATE EXTENSION IF NOT EXISTS pg_trgm",
            ],
            environment: pgEnv,
            timeout: 10
        )

        if !extResult.succeeded {
            logger.warning("pg_trgm extension creation failed: \(extResult.stderr)")
        }
    }

    /// Gracefully stop PostgreSQL.
    func stop() async throws {
        logger.info("Stopping PostgreSQL...")

        let result = try await ProcessRunner.run(
            executable: binDir.appendingPathComponent("pg_ctl"),
            arguments: ["-D", dataDir.path, "-m", "fast", "stop"],
            environment: pgEnv,
            timeout: 15
        )

        if !result.succeeded {
            logger.warning("pg_ctl stop failed: \(result.stderr)")
        }
    }

    /// Check if PostgreSQL is currently accepting connections.
    func isReady() async -> Bool {
        guard let result = try? await ProcessRunner.run(
            executable: binDir.appendingPathComponent("pg_isready"),
            arguments: ["-h", "localhost", "-p", String(port), "-U", "fliks"],
            environment: pgEnv,
            timeout: 5
        ) else {
            return false
        }
        return result.succeeded
    }

    // MARK: - Private

    /// Poll `pg_isready` until success or timeout.
    private func waitForReady(timeout: TimeInterval) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await isReady() { return }
            try await Task.sleep(for: .milliseconds(500))
        }
        throw PostgresError.timeout
    }

    /// Write performance-tuned settings to postgresql.conf after initdb.
    private func tweakConfig() throws {
        let configFile = dataDir.appendingPathComponent("postgresql.conf")
        var config = try String(contentsOf: configFile, encoding: .utf8)

        let tweaks = """

        # --- Fliks embedded settings ---
        listen_addresses = 'localhost'
        shared_buffers = '128MB'
        max_connections = 50
        logging_collector = on
        log_directory = '\(Paths.logsDir.path)'
        """
        config.append(tweaks)
        try config.write(to: configFile, atomically: true, encoding: .utf8)
    }
}

// MARK: - Errors

enum PostgresError: LocalizedError {
    case initFailed(String)
    case startFailed(String)
    case createDBFailed(String)
    case timeout

    var errorDescription: String? {
        switch self {
        case .initFailed(let msg):    return "PostgreSQL init failed: \(msg)"
        case .startFailed(let msg):   return "PostgreSQL start failed: \(msg)"
        case .createDBFailed(let msg): return "Database creation failed: \(msg)"
        case .timeout:                return "PostgreSQL did not become ready in time"
        }
    }
}
