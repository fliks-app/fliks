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
    var onSelectEpisode: (_ mediaId: Int, _ episodeId: Int) -> Void
    var onSelectLibrary: (Int) -> Void
    var onSelectPlaylist: (Int) -> Void
    var onSelectParty: (Int) -> Void

    @Environment(AuthService.self) private var auth
    @Environment(HomeSettingsStore.self) private var homeSettings
    @Environment(PartyService.self) private var party
    @Environment(HomeRefresh.self) private var refresh
    @State private var librariesState: ZoneState<Library> = .loading

    private var requestsAllowed: Bool {
        let perms = auth.currentUser?.permissions ?? []
        return perms.contains("requests.create") || perms.contains("requests.manage")
    }

    private var sections: [ResolvedHomeSection] {
        homeSettings.resolve(libraries: librariesState.items, requestsAllowed: requestsAllowed,
                             partiesSupported: party.partiesSupported)
    }

    private var partiesShown: Bool { sections.contains { $0.type == .watchParties && $0.visible } }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 44) {
                ForEach(sections.filter(\.visible)) { section in
                    HomeRow(
                        section: section,
                        librariesState: librariesState,
                        onRetryLibraries: { Task { await loadLibraries() } },
                        onSelectMedia: onSelectMedia,
                        onSelectEpisode: onSelectEpisode,
                        onSelectLibrary: onSelectLibrary,
                        onSelectPlaylist: onSelectPlaylist,
                        onSelectParty: onSelectParty
                    )
                }
            }
            .padding(.horizontal, 60)
            .padding(.vertical, 48)
        }
        .task { await loadLibraries() }
        .task { await ServerVersion.shared.refresh() }
        // Fetched here, not in the row: an empty rail renders nothing, so a task on it would never run. The
        // stream is only open inside a party, hence the timer instead of `party.updated`.
        .task(id: "\(refresh.tick)-\(partiesShown)") {
            while partiesShown, !Task.isCancelled {
                await party.refreshHomeParties()
                try? await Task.sleep(for: .seconds(15))
            }
        }
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
