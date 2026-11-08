import Foundation

/// Wire `mediaType`; mirrors `MediaKind` in the server and `KIND_REGISTRY` in the client.
enum MediaKind: Hashable, Codable {
    case movie, series, book, comic, album
    /// A kind this build doesn't know yet; keeps the raw value.
    case unknown(String)

    /// The kinds this build renders, sent as `X-Fliks-Kinds`: the server omits any other kind.
    static let known: [MediaKind] = [.movie, .series, .book, .comic]

    /// Kinds offered by the type filters.
    static let filterable: [MediaKind] = [.movie, .series, .album]

    var rawValue: String {
        switch self {
        case .movie: "movie"
        case .series: "series"
        case .book: "book"
        case .comic: "comic"
        case .album: "album"
        case .unknown(let raw): raw
        }
    }

    init(rawValue: String) {
        switch rawValue {
        case "movie": self = .movie
        case "series": self = .series
        case "book": self = .book
        case "comic": self = .comic
        case "album": self = .album
        default: self = .unknown(rawValue)
        }
    }

    init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }

    /// The app can play it; books, comics and future kinds need a reader it doesn't have.
    var isPlayable: Bool {
        switch self {
        case .movie, .series, .album: true
        case .book, .comic, .unknown: false
        }
    }

    /// The kind is made of seasons and episodes.
    var hasChildren: Bool {
        switch self {
        case .series: true
        case .movie, .book, .comic, .album, .unknown: false
        }
    }

    /// i18n key of the type-filter label.
    var labelKey: String {
        switch self {
        case .movie: "library.type.movie"
        case .series: "library.type.series"
        case .book: "library.type.book"
        case .comic: "library.type.comic"
        case .album: "library.type.album"
        case .unknown: "library.type.all"
        }
    }
}
