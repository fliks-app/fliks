import SwiftUI

@main
struct FliksApp: App {
    @StateObject private var appState = AppState()

    var body: some Scene {
        MenuBarExtra {
            MenuBarView(appState: appState)
        } label: {
            Image(systemName: appState.serverState.iconName)
                .renderingMode(.template)
        }
    }
}
