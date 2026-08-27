import ActivityKit
import Foundation

/// Shared by the app and the Live Activity widget — the widget renders the
/// state the `DownloadPlugin` publishes.
///
/// One activity covers the whole download queue rather than one per transfer:
/// an auto-download playlist can enqueue a dozen at once, and a dozen stacked
/// cards is not something the system, or the user, wants to deal with.
///
/// Every user-facing string arrives already translated. ngx-translate is the
/// single source of copy for the app, and a widget extension can't reach it.
struct DownloadActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// 0…1 across every download in the batch, finished ones included.
        var progress: Double
        /// Downloads still to finish. Drives the badge in the compact
        /// presentations, where there is no room for the headline.
        var remaining: Int
        /// Pre-translated: the title when there is one download, a count when
        /// there are several.
        var headline: String
        /// Pre-translated status line — downloading / complete / failed.
        var detail: String
        /// Drives the icon and stops the count badge from lingering; the copy
        /// itself lives in `detail`.
        var finished: Bool
    }
}
