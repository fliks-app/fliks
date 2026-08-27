import ActivityKit
import SwiftUI
import WidgetKit

/// Fliks brand navy, matching the app's launch background.
private let brandBackground = Color(red: 0x1d / 255, green: 0x23 / 255, blue: 0x2a / 255)

private func percentLabel(_ progress: Double) -> String {
    progress.formatted(.percent.precision(.fractionLength(0)))
}

private func iconName(
    _ state: DownloadActivityAttributes.ContentState,
    stale: Bool
) -> String {
    if state.finished { return "checkmark.circle.fill" }
    return stale ? "exclamationmark.circle.fill" : "arrow.down.circle.fill"
}

/// The status line, swapped for the stale copy once the system tells us the
/// content is out of date.
private func detailLabel(
    _ state: DownloadActivityAttributes.ContentState,
    stale: Bool
) -> String {
    stale && !state.finished ? state.stale : state.detail
}

/// Live Activity for the offline download queue: a lock-screen card, plus the
/// Dynamic Island presentations on the models that have one.
struct DownloadLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: DownloadActivityAttributes.self) { context in
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Image(systemName: iconName(context.state, stale: context.isStale))
                        .foregroundStyle(.white)
                    Text(context.state.headline)
                        .font(.headline)
                        .foregroundStyle(.white)
                        .lineLimit(1)
                }
                ProgressView(value: context.state.progress)
                    .tint(.white)
                    .opacity(context.isStale ? 0.4 : 1)
                HStack {
                    Text(detailLabel(context.state, stale: context.isStale))
                    Spacer()
                    Text(percentLabel(context.state.progress)).monospacedDigit()
                }
                .font(.caption)
                .foregroundStyle(.white.opacity(0.7))
            }
            .padding()
            .activityBackgroundTint(brandBackground)
            .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: iconName(context.state, stale: context.isStale))
                        .foregroundStyle(.white)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(percentLabel(context.state.progress)).monospacedDigit()
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(context.state.headline).font(.caption).lineLimit(1)
                        ProgressView(value: context.state.progress)
                            .tint(.white)
                            .opacity(context.isStale ? 0.4 : 1)
                        Text(detailLabel(context.state, stale: context.isStale))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            } compactLeading: {
                // The queue depth is the one thing worth the few points of room
                // here; the headline has nowhere to go.
                if context.state.remaining > 1 && !context.state.finished {
                    Text("\(context.state.remaining)").monospacedDigit()
                } else {
                    Image(systemName: "arrow.down")
                }
            } compactTrailing: {
                Text(percentLabel(context.state.progress)).monospacedDigit()
            } minimal: {
                Image(systemName: iconName(context.state, stale: context.isStale))
            }
        }
    }
}
