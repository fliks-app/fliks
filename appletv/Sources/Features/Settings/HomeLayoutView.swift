import SwiftUI

/// Per-zone visibility + reorder (↑/↓ — remote-friendly, no drag), per-library
/// visibility, and the "recently added" ranking mode.
///
/// Hand-rolled rows rather than `Form`: a focused Form row floods white, which
/// leaves its label white-on-white, and its inline buttons give no hint that
/// they take focus one by one.
struct HomeLayoutView: View {
    @Environment(HomeSettingsStore.self) private var homeSettings
    @Environment(AuthService.self) private var auth
    @Environment(PartyService.self) private var party
    @Environment(LibraryStore.self) private var libraryStore
    @State private var rows: [ResolvedHomeSection] = []
    @State private var confirmReset = false

    private var libraries: [Library] { libraryStore.all }
    private var hiddenLibraryIds: Set<Int> { Set(auth.currentUser?.hiddenLibraryIds ?? []) }

    private var requestsAllowed: Bool {
        let perms = auth.currentUser?.permissions ?? []
        return perms.contains("requests.create") || perms.contains("requests.manage")
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 40) {
                Text(tr("home_settings.title")).font(.title.bold())

                section(title: tr("home_settings.sections_title"), hint: tr("home_settings.sections_hint")) {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                        SettingsRow(label: label(for: row), dimmed: !row.visible) {
                            ReorderControls(isFirst: index == 0, isLast: index == rows.count - 1, visible: row.visible,
                                            onMoveUp: { move(index, by: -1) }, onMoveDown: { move(index, by: 1) },
                                            onToggleVisible: { setVisible(index, !row.visible) })
                        }
                    }
                }

                if !libraries.isEmpty {
                    section(title: tr("home_settings.libraries_title"), hint: tr("home_settings.libraries_hint")) {
                        ForEach(libraries) { library in
                            LibraryRow(
                                library: library,
                                visible: !hiddenLibraryIds.contains(library.id),
                                onToggle: { setLibraryVisible(library.id, $0) }
                            )
                        }
                    }
                }

                section(title: tr("home_settings.recently_added_mode"),
                        hint: tr("home_settings.recently_added_mode_hint")) {
                    HStack(spacing: 16) {
                        modeButton(.media, tr("home_settings.mode_media"))
                        modeButton(.file, tr("home_settings.mode_file"))
                        modeButton(.both, tr("home_settings.mode_both"))
                    }
                }

                Button(tr("home_settings.reset"), systemImage: "arrow.counterclockwise") { confirmReset = true }
                    .buttonStyle(.bordered)
            }
            .padding(.horizontal, 60)
            .padding(.vertical, 48)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .confirmationDialog(tr("home_settings.reset_confirm_title"), isPresented: $confirmReset, titleVisibility: .visible) {
            Button(tr("home_settings.reset"), role: .destructive) {
                homeSettings.resetLayout()
                rebuild()
            }
            Button(tr("common.cancel"), role: .cancel) {}
        } message: {
            Text(tr("home_settings.reset_confirm"))
        }
        .task {
            await libraryStore.load()
            rebuild()
        }
        .onChange(of: auth.currentUser?.hiddenLibraryIds) { _, _ in rebuild() }
    }

    @ViewBuilder
    private func section<Content: View>(title: String, hint: String,
                                        @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title).font(.title3.bold())
            Text(hint).font(.callout).foregroundStyle(.secondary)
            VStack(spacing: 10) { content() }
                .padding(.top, 6)
        }
        .focusSection()
    }

    private func modeButton(_ mode: RecentlyAddedMode, _ label: String) -> some View {
        Button(label) { homeSettings.setMode(mode) }
            .selectableButtonStyle(homeSettings.settings.recentlyAddedMode == mode)
    }

    private func rebuild() {
        let visibleLibraries = libraries.filter { !hiddenLibraryIds.contains($0.id) }
        rows = homeSettings.resolve(libraries: visibleLibraries, requestsAllowed: requestsAllowed,
                                  partiesSupported: party.partiesSupported)
    }

    private func move(_ index: Int, by delta: Int) {
        let target = index + delta
        guard rows.indices.contains(target) else { return }
        rows.swapAt(index, target)
        persist()
    }

    private func setVisible(_ index: Int, _ visible: Bool) {
        let row = rows[index]
        rows[index] = ResolvedHomeSection(key: row.key, type: row.type, visible: visible,
                                          libraryId: row.libraryId, libraryName: row.libraryName)
        persist()
    }

    private func setLibraryVisible(_ id: Int, _ visible: Bool) {
        var hidden = hiddenLibraryIds
        if visible { hidden.remove(id) } else { hidden.insert(id) }
        auth.setLibraryPrefs(order: libraries.map(\.id), hidden: hidden.sorted())
    }

    private func persist() {
        homeSettings.setOrder(rows.map { HomeSectionPref(key: $0.key, visible: $0.visible) })
    }

    private func label(for row: ResolvedHomeSection) -> String {
        switch row.type {
        case .heroCarousel: tr("home_settings.section.hero_carousel")
        case .watchParties: tr("party.rail_title")
        case .libraries: tr("home.libraries")
        case .continueWatching: tr("home.continue_watching")
        case .recommendations: tr("home.recommendations")
        case .receivedRecommendations: tr("home_settings.section.received_recommendations")
        case .likes: tr("home.likes")
        case .recentlyAdded: tr("home.recent_media")
        case .playlists: tr("home.playlists")
        case .comingSoon: tr("home.coming_soon")
        case .requestsRecent: tr("home.requests_recent")
        case .libraryRecent: tr("home.recent_media_in", row.libraryName ?? "")
        }
    }
}

private struct LibraryRow: View {
    let library: Library
    let visible: Bool
    var onToggle: (Bool) -> Void

    var body: some View {
        SettingsRow(label: library.name, icon: library.symbol, tint: library.tint, dimmed: !visible) {
            VisibilityButton(visible: visible) { onToggle(!visible) }
        }
    }
}

struct SettingsRow<Controls: View>: View {
    let label: String
    var icon: String? = nil
    var tint: Color = .white
    var dimmed = false
    @ViewBuilder var controls: () -> Controls

    var body: some View {
        HStack(spacing: 16) {
            if let icon {
                Image(systemName: icon).foregroundStyle(tint)
            }
            Text(label)
                .font(.body)
                .lineLimit(1)
                .foregroundStyle(dimmed ? Color.white.opacity(0.45) : .white)
            Spacer()
            controls()
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 24)
        .background(RoundedRectangle(cornerRadius: 18).fill(Color.white.opacity(0.07)))
    }
}

struct VisibilityButton: View {
    let visible: Bool
    var action: () -> Void

    var body: some View {
        Button(visible ? tr("home_settings.visible") : tr("home_settings.hidden"),
               systemImage: visible ? "eye.fill" : "eye.slash", action: action)
            .buttonStyle(.bordered)
    }
}

/// Move up, move down and show/hide: the controls of a reorderable settings row.
struct ReorderControls: View {
    let isFirst: Bool
    let isLast: Bool
    let visible: Bool
    var onMoveUp: () -> Void
    var onMoveDown: () -> Void
    var onToggleVisible: () -> Void

    var body: some View {
        Button(action: onMoveUp) { Image(systemName: "chevron.up") }.buttonStyle(.bordered).disabled(isFirst)
        Button(action: onMoveDown) { Image(systemName: "chevron.down") }.buttonStyle(.bordered).disabled(isLast)
        VisibilityButton(visible: visible, action: onToggleVisible)
    }
}

