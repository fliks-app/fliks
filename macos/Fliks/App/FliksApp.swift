import SwiftUI

@main
struct FliksApp: App {
    @StateObject private var appState = AppState()

    var body: some Scene {
        MenuBarExtra {
            MenuBarView(appState: appState)
        } label: {
            Image("MenuBarIcon")
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: 18, height: 18)
                .opacity(appState.serverState.menuBarOpacity)
        }
    }
}
