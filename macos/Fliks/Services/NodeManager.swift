import Foundation
import os

/// Manages the Node.js backend process lifecycle: spawn, monitor,
/// crash recovery, and clean shutdown.
///
/// The backend's `process.cwd()` must point to a writable directory
/// (images/, backups/, thumbnails/ are created relative to cwd).
/// We set `currentDirectoryURL` to `~/Library/Application Support/Fliks/data/`
/// and symlink bundle assets (dist, node_modules, package.json) into it.
actor NodeManager {

    private let logger = Logger(subsystem: "app.fliks.macos", category: "Node")

    private var process: Process?
    private var stdoutPipe: Pipe?
    private var stderrPipe: Pipe?
    private var isIntentionallyStopping = false
    private var restartDelay: TimeInterval = 1

    /// Callback fired on the main actor when the backend crashes unexpectedly.
    var onCrash: (@Sendable (Int32) -> Void)?

    // MARK: - Public API

    /// Prepare the working directory (create symlinks from data dir to bundle resources)
    /// and spawn the Node.js backend process.
    func start(config: BackendEnvironment) async throws {
        isIntentionallyStopping = false
        restartDelay = 1

        try prepareWorkingDirectory()

        logger.info("Starting Node.js backend on port \(config.port)...")

        let proc = Process()
        proc.executableURL = Paths.nodeBinary
        proc.arguments = ["dist/main.js"]
        proc.currentDirectoryURL = Paths.dataDir
        proc.environment = config.asEnvironment

        let stdout = Pipe()
        let stderr = Pipe()
        proc.standardOutput = stdout
        proc.standardError = stderr
        self.stdoutPipe = stdout
        self.stderrPipe = stderr

        // Stream stderr to os_log for diagnostics.
        stderr.fileHandleForReading.readabilityHandler = { [logger] handle in
            let data = handle.availableData
            guard !data.isEmpty, let line = String(data: data, encoding: .utf8) else { return }
            logger.info("node: \(line)")
        }

        // Crash recovery handler.
        let intentionalCheck = { @Sendable [weak self] in
            await self?.isIntentionallyStopping ?? true
        }
        let crashCallback = onCrash
        proc.terminationHandler = { process in
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
        logger.info("Node.js process started (PID \(proc.processIdentifier))")

        // Wait for the HTTP server to respond.
        try await waitForHTTPReady(port: config.port, timeout: 120)
        logger.info("Backend is ready at http://localhost:\(config.port)")
    }

    /// Gracefully stop the Node.js process.
    func stop() async {
        isIntentionallyStopping = true
        guard let proc = process, proc.isRunning else { return }

        logger.info("Stopping Node.js (PID \(proc.processIdentifier))...")
        proc.terminate() // SIGTERM

        // Wait up to 5 seconds for graceful exit.
        let deadline = Date().addingTimeInterval(5)
        while proc.isRunning && Date() < deadline {
            try? await Task.sleep(for: .milliseconds(200))
        }

        if proc.isRunning {
            logger.warning("Node.js did not exit in time — sending SIGKILL")
            kill(proc.processIdentifier, SIGKILL)
        }

        self.process = nil
        self.stdoutPipe = nil
        self.stderrPipe = nil
    }

    var isRunning: Bool {
        process?.isRunning ?? false
    }

    // MARK: - Private

    /// Create symlinks in the data directory so the backend finds its code
    /// while using a writable cwd for images/backups/thumbnails.
    private func prepareWorkingDirectory() throws {
        try Paths.ensureDirectory(Paths.dataDir)
        let fm = FileManager.default

        let links: [(source: URL, target: URL)] = [
            (Paths.effectiveBackendDist, Paths.dataDir.appendingPathComponent("dist")),
            (Paths.effectiveBackendModules, Paths.dataDir.appendingPathComponent("node_modules")),
            (Paths.effectiveBackendPackageJSON, Paths.dataDir.appendingPathComponent("package.json")),
        ]

        for link in links {
            // Remove stale symlink if it exists.
            if fm.fileExists(atPath: link.target.path) {
                try fm.removeItem(at: link.target)
            }
            try fm.createSymbolicLink(at: link.target, withDestinationURL: link.source)
        }
    }

    /// Poll the backend's HTTP endpoint until it responds.
    private func waitForHTTPReady(port: UInt16, timeout: TimeInterval) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        let url = URL(string: "http://localhost:\(port)/api")!

        while Date() < deadline {
            do {
                let (_, response) = try await URLSession.shared.data(from: url)
                if let http = response as? HTTPURLResponse, http.statusCode < 500 {
                    return
                }
            } catch {
                // Connection refused — server not ready yet.
            }
            try await Task.sleep(for: .seconds(1))
        }
        throw NodeError.timeout
    }
}

// MARK: - Environment

/// All environment variables needed by the NestJS backend.
struct BackendEnvironment {
    let port: UInt16
    let dbPort: UInt16

    var asEnvironment: [String: String] {
        // Build PATH: resolved ffmpeg + resolved node + Homebrew + system essentials.
        let ffmpegBin = Paths.ffmpegDir.path
        let nodeBin = Paths.nodeBinary.deletingLastPathComponent().path
        let systemPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

        return [
            "NODE_ENV": "production",
            "PORT": String(port),
            "DB_HOST": "localhost",
            "DB_PORT": String(dbPort),
            "DB_USERNAME": "fliks",
            "DB_PASSWORD": "fliks",
            "DB_NAME": "fliks",
            "SERVE_STATIC_PATH": Paths.effectiveClientDir.path,
            "FLIKS_CONF_DIR": Paths.confDir.path,
            "PATH": "\(ffmpegBin):\(nodeBin):\(systemPath)",
            "UV_THREADPOOL_SIZE": "16",
        ]
    }
}

// MARK: - Errors

enum NodeError: LocalizedError {
    case timeout

    var errorDescription: String? {
        "Backend did not become ready in time"
    }
}
