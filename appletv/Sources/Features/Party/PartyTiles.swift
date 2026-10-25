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
        Text(String(name.prefix(1)).uppercased())
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
