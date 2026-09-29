import ActivityKit
import AppIntents
import Foundation

/// Bridge between the widget's buttons and the app. This file is compiled into
/// both targets, but a `LiveActivityIntent` runs in the app process, so the
/// app installs the handler and the widget copy stays nil.
enum RemoteActivityCommands {
    /// playPause, back10, forward10, next, stop or like.
    static var handler: ((String) async -> Void)?

    static func endAll() async {
        await end(Activity<RemoteActivityAttributes>.activities)
    }

    /// Takes a list read by the caller before it suspends, so an activity
    /// requested in the meantime isn't swept up with the old ones.
    static func end(_ activities: [Activity<RemoteActivityAttributes>]) async {
        for activity in activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }
}

@available(iOS 17.0, *)
struct RemoteActivityIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Remote control"
    static var isDiscoverable = false

    @Parameter(title: "Action")
    var action: String

    init() {}

    init(action: String) {
        self.action = action
    }

    /// On the main actor, where the plugin installs the handler.
    @MainActor
    func perform() async throws -> some IntentResult {
        // A cold launch by the intent has no plugin, hence no target to talk
        // to: the card would only sit there frozen.
        if let handler = RemoteActivityCommands.handler {
            await handler(action)
        } else {
            await RemoteActivityCommands.endAll()
        }
        return .result()
    }
}
