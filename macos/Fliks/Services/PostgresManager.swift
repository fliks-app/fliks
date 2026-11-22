import Foundation
import os
import Security

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

    /// Password of the `fliks` role, generated once into `Paths.dbPasswordFile`.
    private var password = ""
    private var passwordUnsaved = false
    var dbPassword: String { password }

    private var hbaFile: URL { dataDir.appendingPathComponent("pg_hba.conf") }

    /// Common environment variables injected into every pg command.
    /// Includes Homebrew lib dirs for transitive dependencies (libintl, libicu, etc.).
    private var pgEnv: [String: String] {
        let brewLib = "/opt/homebrew/lib"
        var env = [
            "DYLD_LIBRARY_PATH": "\(libDir.path):\(brewLib)",
            "DYLD_FALLBACK_LIBRARY_PATH": "\(libDir.path):\(brewLib)",
            "LC_ALL": "C",
        ]
        if !password.isEmpty { env["PGPASSWORD"] = password }
        return env
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
        try loadPassword()
        let pgVersion = dataDir.appendingPathComponent("PG_VERSION")
        guard !FileManager.default.fileExists(atPath: pgVersion.path) else {
            logger.info("PostgreSQL data directory already initialized")
            // A cluster already on scram lost its password file: only single-user mode can reset it.
            if passwordUnsaved && !hbaTrusts() {
                try await resetPasswordSingleUser()
                try savePassword()
            }
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

        // initdb reads the role password from the file.
        try savePassword()
        let result = try await ProcessRunner.run(
            executable: binDir.appendingPathComponent("initdb"),
            arguments: [
                "-D", dataDir.path,
                "--auth=scram-sha-256",
                "--pwfile=\(Paths.dbPasswordFile.path)",
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
        try writeHba()
        logger.info("PostgreSQL initialized successfully")
    }

    /// Start the PostgreSQL server and wait until it accepts connections.
    func start() async throws {
        if await isPostmasterRunning() {
            // A force-quit app leaves its postmaster running.
            logger.info("PostgreSQL is already running")
        } else {
            try await startPostmaster()
        }

        // Poll pg_isready until the server is accepting connections.
        try await waitForReady(timeout: 30)
        // A postmaster that outlived the app may still trust connections in memory
        // while pg_hba.conf already says scram.
        try await reload()
        if hbaTrusts() { try await migrateToScram() }
        logger.info("PostgreSQL is ready")
    }

    /// Create the `fliks` database if it doesn't exist yet.
    func createDatabaseIfNeeded() async throws {
        logger.info("Ensuring 'fliks' database exists...")

        // Check if database exists first to avoid ERROR log on restarts.
        let check = try await ProcessRunner.run(
            executable: binDir.appendingPathComponent("psql"),
            arguments: [
                "-w", "-h", "localhost",
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
                    "-w", "-h", "localhost",
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

        // Ensure pg_trgm extension (the server also does this, but belt-and-suspenders).
        let extResult = try await ProcessRunner.run(
            executable: binDir.appendingPathComponent("psql"),
            arguments: [
                "-w", "-h", "localhost",
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
            arguments: ["-D", dataDir.path, "-m", "fast", "-t", "60", "stop"],
            environment: pgEnv,
            timeout: 65
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

    private func startPostmaster() async throws {
        logger.info("Starting PostgreSQL on port \(self.port)...")

        let result = try await ProcessRunner.run(
            executable: binDir.appendingPathComponent("pg_ctl"),
            arguments: [
                "-D", dataDir.path,
                "-l", logFile.path,
                // postgres word-splits -o: the path is single-quoted, and the empty unix_socket_directories turns the socket off.
                "-o", "-p \(port) -c dynamic_library_path='\(libDir.appendingPathComponent("postgresql").path)' -c unix_socket_directories=''",
                "start",
            ],
            environment: pgEnv,
            timeout: 30
        )

        guard result.succeeded else {
            throw PostgresError.startFailed(result.stderr)
        }
    }

    private func isPostmasterRunning() async -> Bool {
        let result = try? await ProcessRunner.run(
            executable: binDir.appendingPathComponent("pg_ctl"),
            arguments: ["-D", dataDir.path, "status"],
            environment: pgEnv,
            timeout: 10
        )
        return result?.succeeded ?? false
    }

    private func reload() async throws {
        let result = try await ProcessRunner.run(
            executable: binDir.appendingPathComponent("pg_ctl"),
            arguments: ["-D", dataDir.path, "reload"],
            environment: pgEnv,
            timeout: 10
        )
        guard result.succeeded else { throw PostgresError.startFailed("pg_ctl reload: \(result.stderr)") }
    }

    /// Read `.db-password`, or generate a password in memory (64 hex characters): the file is written
    /// by `savePassword` once the role has it, so a failed reset is retried at the next launch.
    private func loadPassword() throws {
        if let existing = try? String(contentsOf: Paths.dbPasswordFile, encoding: .utf8) {
            let trimmed = existing.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil {
                password = trimmed
                passwordUnsaved = false
                return
            }
            logger.warning("The database password file is not 64 hex characters: it is replaced")
        }

        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw PostgresError.initFailed("no random bytes for the database password")
        }
        password = bytes.map { String(format: "%02x", $0) }.joined()
        passwordUnsaved = true
    }

    /// Writes `.db-password` (mode 0600) when `loadPassword` generated it.
    private func savePassword() throws {
        guard passwordUnsaved else { return }
        let file = Paths.dbPasswordFile
        try Paths.ensureDirectory(Paths.confDir)
        let temp = file.path + ".tmp"
        let fd = open(temp, O_WRONLY | O_CREAT | O_TRUNC, 0o600)
        guard fd >= 0 else { throw PostgresError.initFailed("cannot write \(file.path)") }
        let written = write(fd, password, password.utf8.count)
        close(fd)
        guard written == password.utf8.count, rename(temp, file.path) == 0 else {
            throw PostgresError.initFailed("cannot write \(file.path)")
        }
        passwordUnsaved = false
    }

    /// Whether any line of `pg_hba.conf` still uses the `trust` method.
    private func hbaTrusts() -> Bool {
        guard let hba = try? String(contentsOf: hbaFile, encoding: .utf8) else { return false }
        return hba.split(separator: "\n").contains { line in
            let body = line.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).first ?? ""
            return body.split(whereSeparator: \.isWhitespace).contains("trust")
        }
    }

    /// TCP loopback only, scram everywhere: the same file a fresh cluster ends up with.
    private func writeHba() throws {
        let hba = """
        # TYPE  DATABASE  USER  ADDRESS       METHOD
        host    all       all   127.0.0.1/32  scram-sha-256
        host    all       all   ::1/128       scram-sha-256

        """
        try hba.write(to: hbaFile, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: hbaFile.path)
    }

    /// Live repair of a trust cluster: set the role password while trust still lets us in,
    /// then close `pg_hba.conf`. A crash in between leaves `trust`, so the next launch retries.
    private func migrateToScram() async throws {
        logger.info("Switching the PostgreSQL cluster from trust to scram-sha-256")
        // The statement goes through stdin: argv is visible in `ps`, and the output is
        // not logged because an error echoes the statement.
        let result = try await ProcessRunner.run(
            executable: binDir.appendingPathComponent("psql"),
            arguments: ["-w", "-h", "localhost", "-p", String(port), "-U", "fliks", "-d", "postgres",
                        "-v", "ON_ERROR_STOP=1"],
            environment: pgEnv,
            timeout: 10,
            stdin: "SET log_min_error_statement = 'panic';\nALTER ROLE fliks PASSWORD '\(password)';\n"
        )
        guard result.succeeded else {
            throw PostgresError.authFailed("psql exited \(result.exitCode)")
        }
        try savePassword()
        try writeHba()
        try await reload()
    }

    /// `.db-password` is gone while the cluster is already on scram: stop, reset the role
    /// password in single-user mode (statement on stdin, never logged), the caller starts again.
    private func resetPasswordSingleUser() async throws {
        logger.warning("The database password file is missing: resetting the role password")
        if await isPostmasterRunning() { try await stop() }
        let result = try await ProcessRunner.run(
            executable: binDir.appendingPathComponent("postgres"),
            arguments: ["--single", "-D", dataDir.path, "postgres"],
            environment: pgEnv,
            timeout: 30,
            stdin: "ALTER ROLE fliks PASSWORD '\(password)'\n"
        )
        guard result.succeeded else {
            throw PostgresError.authFailed("postgres --single exited \(result.exitCode)")
        }
    }

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

        // Shared with the Windows shell: scripts/embedded-postgres.conf, bundled as a resource.
        guard let template = Bundle.main.url(forResource: "embedded-postgres", withExtension: "conf"),
              let tweaks = try? String(contentsOf: template, encoding: .utf8) else {
            throw PostgresError.initFailed("embedded-postgres.conf is missing from the app bundle")
        }
        config.append(tweaks.replacingOccurrences(of: "@LOG_DIR@", with: Paths.logsDir.path))
        try config.write(to: configFile, atomically: true, encoding: .utf8)
    }
}

// MARK: - Errors

enum PostgresError: LocalizedError {
    case initFailed(String)
    case startFailed(String)
    case createDBFailed(String)
    case authFailed(String)
    case timeout

    var errorDescription: String? {
        switch self {
        case .initFailed(let msg):    return "PostgreSQL init failed: \(msg)"
        case .startFailed(let msg):   return "PostgreSQL start failed: \(msg)"
        case .createDBFailed(let msg): return "Database creation failed: \(msg)"
        case .authFailed(let msg):    return "PostgreSQL password reset failed: \(msg)"
        case .timeout:                return "PostgreSQL did not become ready in time"
        }
    }
}
