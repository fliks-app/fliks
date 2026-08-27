import ActivityKit
import Foundation

/// Shared by the app and the Live Activity widget — the widget renders the
/// state the `DownloadPlugin` publishes.
///
/// Every user-facing string arrives already translated: ngx-translate is the
/// single source of copy for the whole app, and a widget extension has no
/// access to it.
struct DownloadActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// 0…1. Rendered as a bar and as a locale-formatted percentage.
        var progress: Double
        /// Pre-translated status line — downloading / complete / failed.
        var status: String
        /// Drives the icon and the bar tint; the copy itself lives in `status`.
        var finished: Bool
    }

    /// Media title, with its episode label when there is one.
    var title: String
}
