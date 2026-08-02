import SwiftUI

extension Color {
    /// Colors as the web client stores them: a daisyUI theme token
    /// (`primary`, `success`, …) or a CSS hex. Unset means primary there, so
    /// it means primary here.
    static func fliks(_ raw: String?) -> Color {
        guard let trimmed = raw?.trimmingCharacters(in: .whitespaces), !trimmed.isEmpty else {
            return themeTokens["primary"]!
        }
        if let token = themeTokens[trimmed.lowercased()] { return token }
        var hex = Substring(trimmed.hasPrefix("#") ? String(trimmed.dropFirst()) : trimmed)
        if hex.count == 3 { hex = Substring(hex.flatMap { [$0, $0] }) }
        guard hex.count == 6, let value = UInt64(hex, radix: 16) else { return themeTokens["primary"]! }
        return Color(red: Double((value >> 16) & 0xFF) / 255,
                     green: Double((value >> 8) & 0xFF) / 255,
                     blue: Double(value & 0xFF) / 255)
    }

    /// daisyUI's `dark` theme (`client/src/index.html` pins it), converted from
    /// the oklch values in `daisyui/theme/dark.css`.
    private static let themeTokens: [String: Color] = [
        "primary": Color(red: 0.377, green: 0.365, blue: 1.0),
        "secondary": Color(red: 0.957, green: 0.187, blue: 0.597),
        "accent": Color(red: 0.0, green: 0.826, blue: 0.735),
        "neutral": Color(red: 0.6, green: 0.6, blue: 0.62),
        "info": Color(red: 0.0, green: 0.729, blue: 0.996),
        "success": Color(red: 0.0, green: 0.826, blue: 0.566),
        "warning": Color(red: 0.99, green: 0.717, blue: 0.0),
        "error": Color(red: 1.0, green: 0.386, blue: 0.492),
    ]
}

extension Library {
    var tint: Color { .fliks(color) }

    /// Closest SF Symbol to the lucide icon the web client stores.
    var symbol: String {
        switch icon {
        case "film", "clapperboard", "video", "popcorn": "film"
        case "tv", "tv-minimal", "monitor", "monitor-play": "tv"
        case "music", "music-2", "audio-lines": "music.note"
        case "book", "book-open", "library": "books.vertical.fill"
        case "gamepad-2", "joystick": "gamecontroller.fill"
        case "baby", "toy-brick": "figure.and.child.holdinghands"
        default: "folder.fill"
        }
    }
}
