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
    @State private var libraries: [Library] = []
    @State private var hiddenLibraryIds: Set<Int> = []
    @State private var rows: [ResolvedHomeSection] = []
    @State private var confirmReset = false

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
                        HomeZoneRow(
                            label: label(for: row),
                            visible: row.visible,
                            isFirst: index == 0,
                            isLast: index == rows.count - 1,
                            onMoveUp: { move(index, by: -1) },
                            onMoveDown: { move(index, by: 1) },
                            onToggleVisible: { setVisible(index, $0) }
                        )
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

                ControlButton(systemImage: "arrow.counterclockwise",
                              label: tr("home_settings.reset")) { confirmReset = true }
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
            hiddenLibraryIds = Set(auth.currentUser?.hiddenLibraryIds ?? [])
            libraries = (try? await APIClient.shared.get("/api/libraries/mine")) ?? []
            rebuild()
        }
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
        ControlButton(label: label,
                      active: homeSettings.settings.recentlyAddedMode == mode) {
            homeSettings.setMode(mode)
        }
    }

    private func rebuild() {
        let visibleLibraries = libraries.filter { !hiddenLibraryIds.contains($0.id) }
        rows = homeSettings.resolve(libraries: visibleLibraries, requestsAllowed: requestsAllowed)
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
        if visible { hiddenLibraryIds.remove(id) } else { hiddenLibraryIds.insert(id) }
        rebuild()
        Task { await auth.setHiddenLibraries(Array(hiddenLibraryIds)) }
    }

    private func persist() {
        homeSettings.setOrder(rows.map { HomeSectionPref(key: $0.key, visible: $0.visible) })
    }

    private func label(for row: ResolvedHomeSection) -> String {
        switch row.type {
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

private struct HomeZoneRow: View {
    let label: String
    let visible: Bool
    let isFirst: Bool
    let isLast: Bool
    var onMoveUp: () -> Void
    var onMoveDown: () -> Void
    var onToggleVisible: (Bool) -> Void

    var body: some View {
        SettingsRow(label: label, dimmed: !visible) {
            ControlButton(systemImage: "chevron.up", disabled: isFirst, action: onMoveUp)
            ControlButton(systemImage: "chevron.down", disabled: isLast, action: onMoveDown)
            VisibilityButton(visible: visible) { onToggleVisible(!visible) }
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

private struct SettingsRow<Controls: View>: View {
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

private struct VisibilityButton: View {
    let visible: Bool
    var action: () -> Void

    var body: some View {
        ControlButton(systemImage: visible ? "eye.fill" : "eye.slash",
                      label: visible ? tr("home_settings.visible") : tr("home_settings.hidden"),
                      action: action)
    }
}

/// Focusable pill that inverts on focus, so the remote always shows where it is.
private struct ControlButton: View {
    var systemImage: String? = nil
    var label: String? = nil
    var disabled = false
    var active = false
    var action: () -> Void

    @FocusState private var focused: Bool

    private var foreground: Color {
        if disabled { return .white.opacity(0.25) }
        return (focused || active) ? .black : .white
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                if let systemImage { Image(systemName: systemImage) }
                if let label { Text(label).font(.callout) }
            }
            .foregroundStyle(foreground)
            .frame(minWidth: 44)
            .padding(.vertical, 10)
            .padding(.horizontal, 20)
        }
        .buttonStyle(FlatButtonStyle())
        .background(Capsule().fill(focused || active ? Color.white : Color.white.opacity(0.16)))
        // Ring in the brand color, not white: an active control is already
        // white, so a white ring around a focused one would read as the same.
        .overlay(Capsule().strokeBorder(Color.fliks("primary"), lineWidth: focused ? 5 : 0))
        .scaleEffect(focused ? 1.06 : 1)
        .focused($focused)
        .disabled(disabled)
        .animation(.easeOut(duration: 0.12), value: focused)
    }
}
