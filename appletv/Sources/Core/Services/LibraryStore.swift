import Foundation

/// The libraries of the signed-in account, fetched once and read by Home, the sidebar, the library page
/// and the Home layout settings. The hidden set and the order come from the profile (`hiddenLibraryIds`,
/// `libraryOrder`), so a change to either reaches every screen at once.
@MainActor
@Observable final class LibraryStore {
    static let shared = LibraryStore()

    private(set) var state: ZoneState<Library> = .loading
    @ObservationIgnored private var inFlight: Task<Void, Never>?
    @ObservationIgnored private var generation = 0

    private init() {}

    /// Every playable library the account may use, in its saved order, hidden ones included.
    var all: [Library] {
        let order = AuthService.shared.currentUser?.libraryOrder ?? []
        let rank = Dictionary(order.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
        return state.items.enumerated()
            .sorted { (rank[$0.element.id] ?? Int.max, $0.offset) < (rank[$1.element.id] ?? Int.max, $1.offset) }
            .map(\.element)
    }

    var visible: [Library] {
        let hidden = Set(AuthService.shared.currentUser?.hiddenLibraryIds ?? [])
        return all.filter { !hidden.contains($0.id) }
    }

    /// `visible` with the fetch's lifecycle, for the Home rail.
    var visibleState: ZoneState<Library> {
        if case .loaded = state { return .loaded(visible) }
        return state
    }

    func library(_ id: Int) -> Library? { all.first { $0.id == id } }

    /// Paints the cached list, then refreshes it; concurrent callers share one fetch.
    func load() async {
        if let inFlight { return await inFlight.value }
        let epoch = generation
        let task = Task { @MainActor [self] in
            await revalidateZone("libraries", apply: { next in
                if epoch == generation { state = next }
            }) {
                let libraries: [Library] = try await APIClient.shared.list("/api/libraries/mine")
                return libraries.filter(\.isPlayable)
            }
            if epoch == generation { inFlight = nil }
        }
        inFlight = task
        await task.value
    }

    /// The account changed: nothing of the previous one stays.
    func clear() {
        generation += 1
        inFlight = nil
        state = .loading
    }
}
