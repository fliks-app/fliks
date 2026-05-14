import Foundation

/// Lifecycle state of the Fliks server stack (Postgres + Node).
enum ServerState: Equatable {
    case stopped
    case startingPostgres
    case startingBackend
    case running
    case stopping
    case error(String)

    /// SF Symbol name for the menu bar icon.
    var iconName: String {
        switch self {
        case .stopped:           return "film"
        case .startingPostgres,
             .startingBackend:   return "film.circle"
        case .running:           return "film.fill"
        case .stopping:          return "film.circle"
        case .error:             return "exclamationmark.triangle.fill"
        }
    }

    /// Human-readable status text shown at the top of the menu.
    var displayText: String {
        switch self {
        case .stopped:                return "Fliks is stopped"
        case .startingPostgres:       return "Starting database..."
        case .startingBackend:        return "Starting server..."
        case .running:                return "Fliks is running"
        case .stopping:               return "Stopping..."
        case .error(let message):     return "Error: \(message)"
        }
    }

    var isStarting: Bool {
        switch self {
        case .startingPostgres, .startingBackend: return true
        default: return false
        }
    }
}
