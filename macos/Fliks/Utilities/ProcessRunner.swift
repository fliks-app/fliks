import Foundation
import os

/// Result of a synchronous process execution.
struct ProcessResult {
    let exitCode: Int32
    let stdout: String
    let stderr: String

    var succeeded: Bool { exitCode == 0 }
}

/// Lightweight async wrapper around Foundation.Process for running
/// CLI tools (pg_ctl, initdb, createdb, pg_isready, etc.).
enum ProcessRunner {

    private static let logger = Logger(subsystem: "app.fliks.macos", category: "ProcessRunner")

    /// Run a command and wait for completion (with optional timeout).
    /// - Parameters:
    ///   - executable: Full path to the binary.
    ///   - arguments: Command-line arguments.
    ///   - environment: Merged into the inherited environment.
    ///   - currentDirectory: Working directory for the child process.
    ///   - timeout: Maximum wall-clock time. `nil` = no limit.
    ///   - stdin: Written to the child's standard input, then closed (keeps secrets out of argv).
    /// - Returns: `ProcessResult` with captured stdout, stderr, and exit code.
    static func run(
        executable: URL,
        arguments: [String] = [],
        environment: [String: String]? = nil,
        currentDirectory: URL? = nil,
        timeout: TimeInterval? = 30,
        stdin: String? = nil
    ) async throws -> ProcessResult {
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments

        if let currentDirectory {
            process.currentDirectoryURL = currentDirectory
        }

        // Merge extra env vars into inherited environment.
        var env = ProcessInfo.processInfo.environment
        if let extra = environment {
            for (k, v) in extra { env[k] = v }
        }
        process.environment = env

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe
        let stdinPipe = stdin == nil ? nil : Pipe()
        if let stdinPipe { process.standardInput = stdinPipe }

        logger.debug("exec: \(executable.lastPathComponent) \(arguments.joined(separator: " "))")

        try process.run()
        if let stdin, let stdinPipe {
            try? stdinPipe.fileHandleForWriting.write(contentsOf: Data(stdin.utf8))
            try? stdinPipe.fileHandleForWriting.close()
        }

        // Timeout handling via a detached task.
        let timeoutTask: Task<Void, Never>?
        if let timeout {
            let pid = process.processIdentifier
            timeoutTask = Task.detached {
                try? await Task.sleep(for: .seconds(timeout))
                if process.isRunning {
                    logger.warning("Process \(pid) timed out after \(timeout)s — sending SIGTERM")
                    process.terminate()
                }
            }
        } else {
            timeoutTask = nil
        }

        process.waitUntilExit()
        timeoutTask?.cancel()

        let stdoutData = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
        let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()

        let result = ProcessResult(
            exitCode: process.terminationStatus,
            stdout: String(data: stdoutData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "",
            stderr: String(data: stderrData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        )

        if !result.succeeded {
            logger.warning("Process \(executable.lastPathComponent) exited \(result.exitCode): \(result.stderr)")
        }

        return result
    }
}
