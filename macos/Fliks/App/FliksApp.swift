import SwiftUI

@main
struct FliksApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        MenuBarExtra {
            MenuBarView(appState: appDelegate.appState)
        } label: {
            MenuBarLabel(appState: appDelegate.appState)
        }
    }
}

/// Owns the server stack so every quit path can wait for it to stop.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let appState = AppState()

    /// Menu, Cmd-Q, logout and an updater's terminate all land here. Node and
    /// Postgres outlive the app if it exits first, so it only exits once they
    /// have stopped.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if appState.serverState == .stopped { return .terminateNow }
        Task {
            await appState.shutdown()
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}

private struct MenuBarLabel: View {
    @ObservedObject var appState: AppState

    var body: some View {
        Image("MenuBarIcon")
            .resizable()
            .aspectRatio(contentMode: .fit)
            .frame(width: 18, height: 18)
            .opacity(appState.serverState.menuBarOpacity)
    }
}
