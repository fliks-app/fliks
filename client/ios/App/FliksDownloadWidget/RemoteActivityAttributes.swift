import ActivityKit
import Foundation

/// Shared by the app and the Live Activity widget — the widget renders the
/// state the `RemoteNotificationPlugin` publishes for the device this phone
/// controls.
///
/// ActivityKit caps attributes plus state at 4 KB and persists both, so the
/// access token never travels here and the artwork is a few hundred pixels at
/// most. Every user-facing string arrives already translated: a widget
/// extension can't reach ngx-translate.
struct RemoteActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var title: String
        /// The series title while an episode plays.
        var subtitle: String?
        /// Pre-formatted, e.g. "On Living room TV".
        var deviceName: String
        var playing: Bool
        var buffering: Bool
        /// Seconds at `positionDate`; the widget advances it on its own between
        /// updates, since a suspended app can't push any.
        var position: Double
        var positionDate: Date
        var duration: Double
        var hasNext: Bool
        /// A film has nothing to step through: ±10 s replaces next.
        var seekButtons: Bool
        /// Nil until known, which hides the heart.
        var liked: Bool?
        /// Shown instead of the device line once the content goes stale.
        var stale: String
        var artwork: Data?

        var isAdvancing: Bool { playing && !buffering }

        func position(at date: Date) -> Double {
            guard isAdvancing else { return position }
            let advanced = position + max(0, date.timeIntervalSince(positionDate))
            return duration > 0 ? min(advanced, duration) : advanced
        }
    }
}
