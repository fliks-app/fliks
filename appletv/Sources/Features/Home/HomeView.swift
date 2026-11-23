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
    var onPlay: (_ mediaFileId: Int, _ mediaId: Int, _ episodeId: Int?) -> Void
    var onCustomize: () -> Void

    @Environment(AuthService.self) private var auth
    @Environment(HomeSettingsStore.self) private var homeSettings
    @Environment(PartyService.self) private var party
    @Environment(HomeRefresh.self) private var refresh
    @Environment(LibraryStore.self) private var libraries

    private var requestsAllowed: Bool {
        let perms = auth.currentUser?.permissions ?? []
        return perms.contains("requests.create") || perms.contains("requests.manage")
    }

    private var sections: [ResolvedHomeSection] {
        homeSettings.resolve(libraries: libraries.visible, requestsAllowed: requestsAllowed,
                             partiesSupported: party.partiesSupported)
    }

    @State private var featured: ZoneState<FeaturedItem> = .loading

    private var heroVisible: Bool {
        FeaturedItem.supported && sections.contains { $0.type == .heroCarousel && $0.visible }
    }

    /// Holds its place until the picks answer; an empty answer gives the place back.
    private var heroShown: Bool {
        guard heroVisible else { return false }
        if case .loading = featured { return true }
        return !featured.items.isEmpty
    }

    private var partiesShown: Bool { sections.contains { $0.type == .watchParties && $0.visible } }

    /// The empty parties rail's call to action: below every zone, so its arrival moves none of them.
    private var newPartyShown: Bool {
        partiesShown && party.canCreate && party.homePartiesLoaded && party.homeParties.isEmpty
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if heroShown {
                    HeroCarousel(items: featured.items.map(\.media), onPlay: onPlay,
                                 onDetails: { onSelectMedia($0.id) })
                }
                LazyVStack(alignment: .leading, spacing: 44) {
                    ForEach(sections.filter(\.visible)) { section in
                        HomeRow(
                            section: section,
                            librariesState: libraries.visibleState,
                            onRetryLibraries: { Task { await libraries.load() } },
                            onSelectMedia: onSelectMedia,
                            onSelectEpisode: onSelectEpisode,
                            onSelectLibrary: onSelectLibrary,
                            onSelectPlaylist: onSelectPlaylist,
                            onSelectParty: onSelectParty,
                            featuredIds: heroShown ? Set(featured.items.map(\.id)) : []
                        )
                    }
                    HStack(spacing: 40) {
                        if newPartyShown {
                            HomeActionCard(symbol: "person.2", title: tr("party.watch_together"),
                                           hint: tr("party.rail_empty")) { party.openCreate() }
                        }
                        HomeActionCard(symbol: "square.grid.2x2", title: tr("home.customize"),
                                       hint: tr("home.customize_hint"), action: onCustomize)
                    }
                    // Both cards take the taller one's height.
                    .fixedSize(horizontal: false, vertical: true)
                    .focusSection()
                }
                .padding(.horizontal, 60)
                .padding(.vertical, heroShown ? 24 : 48)
            }
        }
        .ignoresSafeArea(edges: heroShown ? .top : [])
        .task(id: "\(refresh.tick)-\(heroVisible)") {
            guard heroVisible else { return }
            await revalidateZone("featured", apply: { featured = $0 }) {
                try await APIClient.shared.list("/api/home/featured")
            }
        }
        .task(id: refresh.tick) { await libraries.load() }
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
}

/// A closing card of the Home, like the web client's "Customize the home" box.
private struct HomeActionCard: View {
    let symbol: String
    let title: String
    let hint: String
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 10) {
                Image(systemName: symbol).font(.title2).foregroundStyle(.secondary)
                Spacer(minLength: 0)
                Text(title).font(.headline)
                Text(hint).font(.callout).foregroundStyle(.secondary).lineLimit(2).fixedSize(horizontal: false, vertical: true)
            }
            .padding(40)
            .frame(width: 760, alignment: .topLeading)
            .frame(maxHeight: .infinity, alignment: .topLeading)
            .background(Color.white.opacity(0.08))
        }
        .buttonStyle(.card)
    }
}
