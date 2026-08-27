import ActivityKit
import SwiftUI
import WidgetKit

/// Fliks brand navy, matching the app's launch background.
private let brandBackground = Color(red: 0x1d / 255, green: 0x23 / 255, blue: 0x2a / 255)

private func percentLabel(_ progress: Double) -> String {
    progress.formatted(.percent.precision(.fractionLength(0)))
}

/// Live Activity for an offline download: a lock-screen card, plus the Dynamic
/// Island presentations on the models that have one.
struct DownloadLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: DownloadActivityAttributes.self) { context in
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Image(systemName: context.state.finished
                        ? "checkmark.circle.fill"
                        : "arrow.down.circle.fill")
                        .foregroundStyle(.white)
                    Text(context.attributes.title)
                        .font(.headline)
                        .foregroundStyle(.white)
                        .lineLimit(1)
                }
                ProgressView(value: context.state.progress)
                    .tint(.white)
                HStack {
                    Text(context.state.status)
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
                    Image(systemName: context.state.finished
                        ? "checkmark.circle.fill"
                        : "arrow.down.circle.fill")
                        .foregroundStyle(.white)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(percentLabel(context.state.progress)).monospacedDigit()
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(context.attributes.title).font(.caption).lineLimit(1)
                        ProgressView(value: context.state.progress).tint(.white)
                        Text(context.state.status)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            } compactLeading: {
                Image(systemName: "arrow.down")
            } compactTrailing: {
                Text(percentLabel(context.state.progress)).monospacedDigit()
            } minimal: {
                Image(systemName: "arrow.down")
            }
        }
    }
}
