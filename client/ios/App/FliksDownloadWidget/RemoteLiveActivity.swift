import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

private typealias RemoteState = RemoteActivityAttributes.ContentState

private func clock(_ seconds: Double) -> String {
    let total = max(0, Int(seconds))
    let hours = total / 3600
    let minutes = (total % 3600) / 60
    let secs = total % 60
    return hours > 0
        ? String(format: "%d:%02d:%02d", hours, minutes, secs)
        : String(format: "%d:%02d", minutes, secs)
}

private func subline(_ state: RemoteState, stale: Bool) -> String {
    stale ? state.stale : state.deviceName
}

private struct Artwork: View {
    let data: Data?
    let height: CGFloat

    var body: some View {
        if let data, let image = UIImage(data: data) {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .frame(maxWidth: height * 1.8, maxHeight: height)
                .clipShape(RoundedRectangle(cornerRadius: 6))
        }
    }
}

/// Moves on its own from the anchor while playing; a static bar otherwise.
/// A stale card can't vouch for the anchor any more, so it stops too.
private struct PlaybackProgress: View {
    let state: RemoteState
    let stale: Bool

    var body: some View {
        if state.duration <= 0 {
            EmptyView()
        } else {
            VStack(spacing: 2) {
                if state.isAdvancing && !stale {
                    let start = state.positionDate.addingTimeInterval(-state.position)
                    let range = start...start.addingTimeInterval(state.duration)
                    ProgressView(timerInterval: range, countsDown: false, label: { EmptyView() }, currentValueLabel: { EmptyView() })
                        .tint(.white)
                    HStack {
                        Text(timerInterval: range, countsDown: false)
                            .monospacedDigit()
                            .frame(maxWidth: 64, alignment: .leading)
                        Spacer()
                        Text(clock(state.duration)).monospacedDigit()
                    }
                } else {
                    ProgressView(value: min(state.position, state.duration), total: state.duration)
                        .tint(.white)
                        .opacity(stale ? 0.4 : 1)
                    HStack {
                        Text(clock(state.position)).monospacedDigit()
                        Spacer()
                        Text(clock(state.duration)).monospacedDigit()
                    }
                }
            }
            .font(.caption2)
            .foregroundStyle(.white.opacity(0.7))
        }
    }
}

@available(iOS 17.0, *)
private struct Control: View {
    let action: String
    let symbol: String

    var body: some View {
        Button(intent: RemoteActivityIntent(action: action)) {
            Image(systemName: symbol)
                .font(.title3)
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity, minHeight: 40)
        }
        .buttonStyle(.plain)
    }
}

@available(iOS 17.0, *)
private struct Controls: View {
    let state: RemoteState

    var body: some View {
        HStack(spacing: 0) {
            if state.seekButtons {
                Control(action: "back10", symbol: "gobackward.10")
            }
            Control(action: "playPause", symbol: state.playing ? "pause.fill" : "play.fill")
            if state.seekButtons {
                Control(action: "forward10", symbol: "goforward.10")
            } else if state.hasNext {
                Control(action: "next", symbol: "forward.end.fill")
            }
            if let liked = state.liked {
                Control(action: "like", symbol: liked ? "heart.fill" : "heart")
            }
            Control(action: "stop", symbol: "xmark")
        }
    }
}

/// The buttons need iOS 17; earlier systems get the card without them.
private struct ControlsRow: View {
    let state: RemoteState

    var body: some View {
        if #available(iOS 17.0, *) {
            Controls(state: state)
        }
    }
}

private struct Card: View {
    let state: RemoteState
    let stale: Bool

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 12) {
                Artwork(data: state.artwork, height: 56)
                VStack(alignment: .leading, spacing: 2) {
                    Text(state.title)
                        .font(.headline)
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    if let subtitle = state.subtitle, !subtitle.isEmpty {
                        Text(subtitle)
                            .font(.subheadline)
                            .foregroundStyle(.white.opacity(0.85))
                            .lineLimit(1)
                    }
                    Text(subline(state, stale: stale))
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.7))
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            PlaybackProgress(state: state, stale: stale)
            ControlsRow(state: state)
        }
        .padding()
    }
}

/// Live Activity for the device this phone controls: a lock-screen card with
/// transport buttons, plus the Dynamic Island presentations.
struct RemoteLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RemoteActivityAttributes.self) { context in
            Card(state: context.state, stale: context.isStale)
                .activityBackgroundTint(brandBackground)
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Artwork(data: context.state.artwork, height: 44)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(context.state.title).font(.caption).lineLimit(1)
                        Text(subline(context.state, stale: context.isStale))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(spacing: 6) {
                        PlaybackProgress(state: context.state, stale: context.isStale)
                        ControlsRow(state: context.state)
                    }
                }
            } compactLeading: {
                Image(systemName: "tv")
            } compactTrailing: {
                Image(systemName: context.state.playing ? "play.fill" : "pause.fill")
                    .opacity(context.isStale ? 0.4 : 1)
            } minimal: {
                Image(systemName: "tv")
            }
        }
    }
}
