import SwiftUI

/// SwiftUI content rendered inside the MenuBarExtra popover.
struct MenuBarView: View {
    @ObservedObject var appState: AppState

    var body: some View {
        // Status header
        HStack(spacing: 6) {
            Circle()
                .fill(statusColor)
                .frame(width: 8, height: 8)
            Text(appState.serverState.displayText)
        }

        if appState.serverState == .running {
            Text("http://localhost:\(appState.config.port)")
                .font(.caption)
                .foregroundStyle(.secondary)
        }

        Divider()

        // Open in browser
        Button("Open Fliks") {
            appState.openInBrowser()
        }
        .keyboardShortcut("o")
        .disabled(appState.serverState != .running)

        Divider()

        // Start at login toggle
        Toggle("Start at Login", isOn: Binding(
            get: { appState.config.startAtLogin },
            set: { appState.config.startAtLogin = $0 }
        ))

        Divider()

        // Server controls
        Button("Restart Server") {
            Task { await appState.restart() }
        }
        .keyboardShortcut("r")
        .disabled(appState.serverState.isStarting || appState.serverState == .stopping)

        Button("View Logs...") {
            openLogs()
        }

        Divider()

        Button("Quit Fliks") {
            Task {
                await appState.shutdown()
                NSApp.terminate(nil)
            }
        }
        .keyboardShortcut("q")
    }

    private var statusColor: Color {
        switch appState.serverState {
        case .running:                        return .green
        case .startingPostgres,
             .startingBackend, .stopping:     return .orange
        case .stopped:                        return .gray
        case .error:                          return .red
        }
    }

    private func openLogs() {
        // Open the Fliks log directory in Finder.
        NSWorkspace.shared.open(Paths.logsDir)
    }
}
