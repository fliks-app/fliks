import Foundation

/// App-wide navigation targets, pushed onto the single root `NavigationPath`.
enum Route: Hashable {
    // Onboarding (P2)
    case quickConnect(userId: Int, username: String)
    case login(username: String?)

    // Main shell. `.home` is unused for now — the shell's root content
    // already is Home; kept so a future "jump to Home" action has a target.
    case home
    case library(id: Int)
    case mediaDetail(id: Int)
    case search
    case playlists
    case playlistDetail(id: Int)
    case settings

    // `episodeId` is nil for a movie; `startAt` is the resume position in
    // seconds (0 = from start).
    case player(mediaFileId: Int, mediaId: Int, episodeId: Int?, startAt: Double)
}
