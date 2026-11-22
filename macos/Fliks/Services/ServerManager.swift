import Foundation
import os

/// Manages the fliks-engine supervisor and its fliks-server child: spawn,
/// monitor, crash recovery, and clean shutdown.
///
/// The cwd is `~/Library/Application Support/Fliks Server/data/`: existing
/// installs keep `images/` and `backups/` there.
actor ServerManager {

    private let logger = Logger(subsystem: "app.fliks.macos", category: "Server")

    private var process: Process?
    private var stdoutPipe: Pipe?
    private var stderrPipe: Pipe?
    private var logFileHandle: FileHandle?
    private var isIntentionallyStopping = false

    /// Callback fired on the main actor when the server crashes unexpectedly.
    var onCrash: (@Sendable (Int32) -> Void)?

    // MARK: - Public API

    /// Spawn the engine, which runs fliks-server behind it.
    func start(config: ServerEnvironment) async throws {
        isIntentionallyStopping = false

        try prepareWorkingDirectory()

        logger.info("Starting the server on port \(config.port)...")

        guard let engine = Paths.engineBinary else { throw ServerError.missingEngine }
        let proc = Process()
        proc.executableURL = engine
        // The engine owns the public port; fliks-server listens on port + 1 behind it.
        proc.arguments = ["--supervise", "--public-listen", "0.0.0.0:\(config.port)",
                          "--upstream", "http://127.0.0.1:\(config.port + 1)",
                          "--", engine.deletingLastPathComponent().appendingPathComponent("fliks-server").path]
        proc.currentDirectoryURL = Paths.dataDir
        proc.environment = config.asEnvironment

        let stdout = Pipe()
        let stderr = Pipe()
        proc.standardOutput = stdout
        proc.standardError = stderr
        self.stdoutPipe = stdout
        self.stderrPipe = stderr

        // Write server logs to daily file + os_log.
        try? Paths.ensureDirectory(Paths.logsDir)
        let logHandle = Self.openLogFile(Paths.logsDir)
        self.logFileHandle = logHandle

        let handleOutput = { [logger] (pipe: Pipe) in
            pipe.fileHandleForReading.readabilityHandler = { handle in
                let data = handle.availableData
                guard !data.isEmpty else { return }
                logHandle?.write(data)
                if let line = String(data: data, encoding: .utf8) {
                    logger.info("server: \(line)")
                }
            }
        }
        handleOutput(stdout)
        handleOutput(stderr)

        // Crash recovery handler.
        let intentionalCheck = { @Sendable [weak self] in
            await self?.isIntentionallyStopping ?? true
        }
        let crashCallback = onCrash
        proc.terminationHandler = { process in
            // The engine leads its own process group, which every ffmpeg it
            // spawns joins. An engine that dies without its shutdown hooks
            // (SIGKILL, crash) leaves them running, an ffmpeg still writing
            // into the transcode cache the next server serves from.
            kill(-process.processIdentifier, SIGKILL)
            let code = process.terminationStatus
            Task {
                let intentional = await intentionalCheck()
                if code != 0 && !intentional {
                    crashCallback?(code)
                }
            }
        }

        try proc.run()
        self.process = proc
        logger.info("Engine process started (PID \(proc.processIdentifier))")

        // Wait for the HTTP server to respond.
        try await waitForHTTPReady(port: config.port, timeout: 120)
        logger.info("Server is ready at http://localhost:\(config.port)")
    }

    /// The engine gives its server 10 s to drain before killing it; this adds a margin.
    private static let stopGrace: TimeInterval = 15

    /// Gracefully stop the engine and its server.
    func stop() async {
        isIntentionallyStopping = true
        guard let proc = process, proc.isRunning else { return }

        logger.info("Stopping the engine (PID \(proc.processIdentifier))...")
        proc.terminate() // SIGTERM

        let deadline = Date().addingTimeInterval(Self.stopGrace)
        while proc.isRunning && Date() < deadline {
            try? await Task.sleep(for: .milliseconds(200))
        }

        if proc.isRunning {
            logger.warning("The engine did not exit in time — sending SIGKILL")
            kill(proc.processIdentifier, SIGKILL)
        }

        self.process = nil
        self.stdoutPipe = nil
        self.stderrPipe = nil
        self.logFileHandle?.closeFile()
        self.logFileHandle = nil
    }

    var isRunning: Bool {
        process?.isRunning ?? false
    }

    // MARK: - Private

    /// Open (or create) the daily server log file for appending.
    /// File name: `server-2026-05-15.log`
    private static func openLogFile(_ baseDir: URL) -> FileHandle? {
        let fm = FileManager.default
        let dateStr = Self.dayFormatter.string(from: Date())
        let url = baseDir.appendingPathComponent("server-\(dateStr).log")
        if !fm.fileExists(atPath: url.path) {
            fm.createFile(atPath: url.path, contents: nil)
        }
        let handle = try? FileHandle(forWritingTo: url)
        handle?.seekToEndOfFile()
        let header = "\n--- Fliks server started at \(ISO8601DateFormatter().string(from: Date())) ---\n"
        handle?.write(header.data(using: .utf8) ?? Data())
        return handle
    }

    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    /// Create the data directory and drop the code symlinks a 4.x install left in it.
    private func prepareWorkingDirectory() throws {
        try Paths.ensureDirectory(Paths.dataDir)
        for name in ["dist", "node_modules", "package.json"] {
            try? FileManager.default.removeItem(at: Paths.dataDir.appendingPathComponent(name))
        }
    }

    /// Poll `/api/system/health` until the app answers: during boot it is 503, then 401 or 200.
    private func waitForHTTPReady(port: UInt16, timeout: TimeInterval) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        let url = URL(string: "http://localhost:\(port)/api/system/health")!

        while Date() < deadline {
            do {
                let (_, response) = try await URLSession.shared.data(from: url)
                if let http = response as? HTTPURLResponse, http.statusCode != 503 {
                    return
                }
            } catch {
                // Connection refused — server not ready yet.
            }
            try await Task.sleep(for: .seconds(1))
        }
        throw ServerError.timeout
    }
}

// MARK: - Environment

/// All environment variables needed by fliks-server and the engine.
struct ServerEnvironment {
    let port: UInt16
    let dbPort: UInt16
    let dbPassword: String

    var asEnvironment: [String: String] {
        // Build PATH: tools pack + pg_dump/psql + Homebrew + system essentials.
        let toolsBin = Paths.toolsDir.path
        let pgBin = Paths.pgBinDir.path
        let systemPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

        var env: [String: String] = [
            "PORT": String(port),
            "FLIKS_BIND": "127.0.0.1",
            "DB_HOST": "localhost",
            "DB_PORT": String(dbPort),
            "DB_USERNAME": "fliks",
            "DB_PASSWORD": dbPassword,
            "DB_NAME": "fliks",
            "SERVE_STATIC_PATH": Paths.effectiveClientDir.path,
            "FLIKS_CONF_DIR": Paths.confDir.path,
            "PATH": "\(toolsBin):\(pgBin):\(systemPath)",
            "FLIKS_CAST_DIR": Paths.effectiveCastDir.path,
        ]
        return env
    }
}

// MARK: - Errors

enum ServerError: LocalizedError {
    case timeout
    case missingEngine

    var errorDescription: String? {
        switch self {
        case .timeout: "Server did not become ready in time"
        case .missingEngine: "fliks-engine is missing from the app bundle"
        }
    }
}
