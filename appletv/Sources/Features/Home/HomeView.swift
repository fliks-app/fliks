import SwiftUI

/// Bumped when the app returns to the Home root so dynamic zones (continue-
/// watching, recommendations, likes…) refetch and reflect what just changed.
@Observable final class HomeRefresh {
    static let shared = HomeRefresh()
    private init() {}
    var tick = 0
    func bump() { tick += 1 }
}

/// Home: resolves the user's zone layout and renders only the visible zones,
/// in order. Each zone (`HomeRow`) owns its own fetch/loading/empty/error
/// state — nothing here blocks on the others, so a slow or failing zone
/// never blanks the rest of the page.
struct HomeView: View {
    var onSelectMedia: (Int) -> Void
    var onSelectLibrary: (Int) -> Void
    var onSelectPlaylist: (Int) -> Void

    @Environment(AuthService.self) private var auth
    @Environment(HomeSettingsStore.self) private var homeSettings
    @State private var librariesState: ZoneState<Library> = .loading

    private var requestsAllowed: Bool {
        let perms = auth.currentUser?.permissions ?? []
        return perms.contains("requests.create") || perms.contains("requests.manage")
    }

    private var sections: [ResolvedHomeSection] {
        homeSettings.resolve(libraries: librariesState.items, requestsAllowed: requestsAllowed)
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 44) {
                ForEach(sections.filter(\.visible)) { section in
                    HomeRow(
                        section: section,
                        librariesState: librariesState,
                        onRetryLibraries: { Task { await loadLibraries() } },
                        onSelectMedia: onSelectMedia,
                        onSelectLibrary: onSelectLibrary,
                        onSelectPlaylist: onSelectPlaylist
                    )
                }
            }
            .padding(.horizontal, 60)
            .padding(.vertical, 48)
        }
        .task { await loadLibraries() }
    }

    private func loadLibraries() async {
        // `hiddenLibraryIds` is a display preference the clients apply
        // themselves — the endpoint returns everything the ACL allows.
        let hidden = Set(auth.currentUser?.hiddenLibraryIds ?? [])
        await revalidateZone("libraries", apply: { librariesState = $0 }) {
            let libraries: [Library] = try await APIClient.shared.get("/api/libraries/mine")
            return libraries.filter { !hidden.contains($0.id) }
        }
    }
}
