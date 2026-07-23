import SwiftUI

@main
struct FliksTVApp: App {
    init() { ImageCache.configure() }

    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}
