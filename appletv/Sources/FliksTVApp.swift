import SwiftUI

@main
struct FliksTVApp: App {
    init() {
        ImageCache.configure()
        SoundManager.useAmbientSession()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}
