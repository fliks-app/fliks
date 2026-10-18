import Foundation
import os
import AppKit

/// Central state object that orchestrates the full Fliks server
/// lifecycle: PostgreSQL → engine + fliks-server → ready.
@MainActor
final class AppState: ObservableObject {

    private let logger = Logger(subsystem: "app.fliks.macos", category: "AppState")

    @Published var serverState: ServerState = .stopped

    let config = ConfigStore()
    let postgresManager: PostgresManager
    let serverManager = ServerManager()

    /// Periodic Postgres health check timer.
    private var healthCheckTimer: Timer?

    /// The start in flight, if any: a shutdown cancels and awaits it, or it
    /// would spawn the server or Postgres after the stop and outlive the app.
    private var startupTask: Task<Void, Never>?

    init() {
        self.postgresManager = PostgresManager(port: config.pgPort)

        // Start the server stack on launch.
        startupTask = Task { await startAll() }
    }

    // MARK: - Lifecycle

    /// Full startup sequence: Postgres → server.
    func startAll() async {
        do {
            try Paths.ensureAppSupportStructure()

            // 1. PostgreSQL
            serverState = .startingPostgres
            try await postgresManager.initialize()
            try await postgresManager.start()
            try await postgresManager.createDatabaseIfNeeded()
            try Task.checkCancellation()

            // 2. Engine + fliks-server
            serverState = .startingServer
            let env = ServerEnvironment(port: config.port, dbPort: config.pgPort)

            await serverManager.setOnCrash { [weak self] exitCode in
                Task { @MainActor in
                    self?.handleServerCrash(exitCode: exitCode)
                }
            }

            try await serverManager.start(config: env)

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

    /// Clean shutdown: server first, then Postgres.
    func shutdown() async {
        serverState = .stopping
        healthCheckTimer?.invalidate()
        healthCheckTimer = nil
        startupTask?.cancel()
        await startupTask?.value
        startupTask = nil

        await serverManager.stop()
        try? await postgresManager.stop()

        serverState = .stopped
    }

    /// Restart: stop everything, then start again.
    func restart() async {
        await shutdown()
        let task = Task { await startAll() }
        startupTask = task
        await task.value
    }

    /// Open the web UI in the default browser.
    func openInBrowser() {
        let url = URL(string: "http://localhost:\(config.port)")!
        NSWorkspace.shared.open(url)
    }

    // MARK: - Crash Recovery

    private func handleServerCrash(exitCode: Int32) {
        logger.warning("The server crashed with exit code \(exitCode)")
        serverState = .error("Server crashed (exit \(exitCode))")

        // Auto-restart after a delay.
        startupTask = Task {
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled, case .error = self.serverState else { return }
            logger.info("Auto-restarting the server...")
            self.serverState = .startingServer
            let env = ServerEnvironment(port: self.config.port, dbPort: self.config.pgPort)
            do {
                try await self.serverManager.start(config: env)
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

// MARK: - ServerManager helper

extension ServerManager {
    func setOnCrash(_ handler: @escaping @Sendable (Int32) -> Void) {
        self.onCrash = handler
    }
}
