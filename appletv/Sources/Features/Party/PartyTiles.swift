import SwiftUI

enum PartyBadge {
    struct Badge { let symbol: String; let color: Color }

    static func status(_ status: String) -> Badge {
        switch status {
        case "ready": return Badge(symbol: "checkmark.circle.fill", color: .green)
        case "buffering": return Badge(symbol: "arrow.triangle.2.circlepath.circle.fill", color: .yellow)
        case "away": return Badge(symbol: "moon.zzz.fill", color: .gray)
        default: return Badge(symbol: "clock.fill", color: .orange)
        }
    }
}

/// Round avatar with its name and a caption below it, outside the focusable circle so the focus lift never
/// clips the text. Focusable only when it has an `action`.
struct AvatarTile: View {
    let name: String
    var caption: String?
    var badge: PartyBadge.Badge?
    var dimmed = false
    /// An SF Symbol in place of the initial (the "add" tile).
    var symbol: String?
    var action: (() -> Void)?

    var body: some View {
        VStack(spacing: 14) {
            if let action {
                Button(action: action) { circle }.buttonStyle(.borderless)
            } else {
                circle
            }
            VStack(spacing: 4) {
                Text(name).font(.callout.weight(.semibold)).lineLimit(1)
                if let caption { Text(caption).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
            }
            .frame(width: 160)
        }
        .opacity(dimmed ? 0.5 : 1)
    }

    private var circle: some View {
        Group {
            if let symbol { Image(systemName: symbol) } else { Text(String(name.prefix(1)).uppercased()) }
        }
            .font(.system(size: 52, weight: .bold))
            .frame(width: 140, height: 140)
            .background(Circle().fill(.white.opacity(0.18)))
            .overlay(alignment: .bottomTrailing) {
                if let badge {
                    Image(systemName: badge.symbol)
                        .font(.system(size: 38))
                        .foregroundStyle(.white, badge.color)
                        .background(Circle().fill(.black.opacity(0.5)))
                }
            }
    }
}

/// Destructive action: red text on the translucent button, dark red on the white focused one, so it
/// stays legible in both states (the system bordered style renders light red on white).
struct DestructiveButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Body(configuration: configuration)
    }

    private struct Body: View {
        let configuration: ButtonStyle.Configuration
        @Environment(\.isFocused) private var focused

        var body: some View {
            configuration.label
                .font(.callout.weight(.semibold))
                .foregroundStyle(focused ? Color(red: 0.62, green: 0.05, blue: 0.05) : Color(red: 1, green: 0.38, blue: 0.35))
                .padding(.horizontal, 28)
                .padding(.vertical, 16)
                .background(Capsule().fill(focused ? Color.white : Color.white.opacity(0.16)))
                .scaleEffect(focused ? 1.06 : 1)
                .opacity(configuration.isPressed ? 0.85 : 1)
                .animation(.easeOut(duration: 0.15), value: focused)
        }
    }
}
