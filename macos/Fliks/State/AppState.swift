import Foundation
import os
import AppKit

/// Central state object that orchestrates the full Fliks server
/// lifecycle: PostgreSQL → Node.js backend → ready.
@MainActor
final class AppState: ObservableObject {

    private let logger = Logger(subsystem: "app.fliks.macos", category: "AppState")

    @Published var serverState: ServerState = .stopped

    let config = ConfigStore()
    let postgresManager: PostgresManager
    let nodeManager = NodeManager()

    /// Periodic Postgres health check timer.
    private var healthCheckTimer: Timer?

    init() {
        self.postgresManager = PostgresManager(port: config.pgPort)

        // Clean shutdown on app termination.
        NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            Task { await self.shutdown() }
        }

        // Start the server stack on launch.
        Task { await startAll() }
    }

    // MARK: - Lifecycle

    /// Full startup sequence: Postgres → Node.
    func startAll() async {
        do {
            try Paths.ensureAppSupportStructure()

            // 1. PostgreSQL
            serverState = .startingPostgres
            try await postgresManager.initialize()
            try await postgresManager.start()
            try await postgresManager.createDatabaseIfNeeded()

            // 2. Node.js backend
            serverState = .startingBackend
            let env = BackendEnvironment(port: config.port, dbPort: config.pgPort)

            await nodeManager.setOnCrash { [weak self] exitCode in
                Task { @MainActor in
                    self?.handleNodeCrash(exitCode: exitCode)
                }
            }

            try await nodeManager.start(config: env)

            serverState = .running
            startHealthChecks()

            // Open browser on first launch.
            if !config.hasCompletedFirstLaunch {
                openInBrowser()
                config.hasCompletedFirstLaunch = true
            }

            logger.info("Fliks is running at http://localhost:\(self.config.port)")

        } catch {
            logger.error("Startup failed: \(error.localizedDescription)")
            serverState = .error(error.localizedDescription)
        }
    }

    /// Clean shutdown: Node first, then Postgres.
    func shutdown() async {
        serverState = .stopping
        healthCheckTimer?.invalidate()
        healthCheckTimer = nil

        await nodeManager.stop()
        try? await postgresManager.stop()

        serverState = .stopped
    }

    /// Restart: stop everything, then start again.
    func restart() async {
        await shutdown()
        await startAll()
    }

    /// Open the web UI in the default browser.
    func openInBrowser() {
        let url = URL(string: "http://localhost:\(config.port)")!
        NSWorkspace.shared.open(url)
    }

    // MARK: - Crash Recovery

    private func handleNodeCrash(exitCode: Int32) {
        logger.warning("Node.js crashed with exit code \(exitCode)")
        serverState = .error("Backend crashed (exit \(exitCode))")

        // Auto-restart after a delay.
        Task {
            try? await Task.sleep(for: .seconds(3))
            guard case .error = self.serverState else { return }
            logger.info("Auto-restarting backend...")
            self.serverState = .startingBackend
            let env = BackendEnvironment(port: self.config.port, dbPort: self.config.pgPort)
            do {
                try await self.nodeManager.start(config: env)
                self.serverState = .running
            } catch {
                self.serverState = .error(error.localizedDescription)
            }
        }
    }

    // MARK: - Health Checks

    private func startHealthChecks() {
        healthCheckTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task {
                let pgOk = await self.postgresManager.isReady()
                if !pgOk && self.serverState == .running {
                    self.logger.warning("PostgreSQL health check failed — restarting")
                    await self.restart()
                }
            }
        }
    }
}

// MARK: - NodeManager helper

extension NodeManager {
    func setOnCrash(_ handler: @escaping @Sendable (Int32) -> Void) {
        self.onCrash = handler
    }
}
