import Foundation

/// Lifecycle state of the Fliks server stack (Postgres + engine + fliks-server).
enum ServerState: Equatable {
    case stopped
    case startingPostgres
    case startingServer
    case running
    case stopping
    case error(String)

    /// Menu bar icon opacity — dims when not running, full when active.
    var menuBarOpacity: Double {
        switch self {
        case .running:                            return 1.0
        case .startingPostgres, .startingServer,
             .stopping:                           return 0.5
        case .stopped, .error:                    return 0.3
        }
    }

    /// Human-readable status text shown at the top of the menu.
    var displayText: String {
        switch self {
        case .stopped:                return "Fliks is stopped"
        case .startingPostgres:       return "Starting database..."
        case .startingServer:        return "Starting server..."
        case .running:                return "Fliks is running"
        case .stopping:               return "Stopping..."
        case .error(let message):     return "Error: \(message)"
        }
    }

    var isStarting: Bool {
        switch self {
        case .startingPostgres, .startingServer: return true
        default: return false
        }
    }
}
