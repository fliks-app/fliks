import SwiftUI

/// Per-zone visibility + reorder (↑/↓ — remote-friendly, no drag) and the
/// "recently added" ranking mode, driving `HomeSettingsStore` directly.
/// `rows` is the resolved working copy (mirrors the Angular `rows` signal);
/// every mutation re-persists immediately via `setOrder`.
struct HomeLayoutView: View {
    @Environment(HomeSettingsStore.self) private var homeSettings
    @Environment(AuthService.self) private var auth
    @State private var libraries: [Library] = []
    @State private var rows: [ResolvedHomeSection] = []
    @State private var confirmReset = false

    private var requestsAllowed: Bool {
        let perms = auth.currentUser?.permissions ?? []
        return perms.contains("requests.create") || perms.contains("requests.manage")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(tr("home_settings.title"))
                .font(.title.bold())
                .padding(.horizontal, 60)
                .padding(.top, 48)
                .padding(.bottom, 24)
            Form {
                Section {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                        HomeLayoutRow(
                            row: row,
                            isFirst: index == 0,
                            isLast: index == rows.count - 1,
                            onMoveUp: { move(index, by: -1) },
                            onMoveDown: { move(index, by: 1) },
                            onToggleVisible: { setVisible(index, $0) }
                        )
                    }
                } header: {
                    Text(tr("home_settings.sections_title"))
                } footer: {
                    Text(tr("home_settings.sections_hint"))
                }

                Section {
                    Picker(tr("home_settings.recently_added_mode"), selection: modeBinding) {
                        Text(tr("home_settings.mode_media")).tag(RecentlyAddedMode.media)
                        Text(tr("home_settings.mode_file")).tag(RecentlyAddedMode.file)
                        Text(tr("home_settings.mode_both")).tag(RecentlyAddedMode.both)
                    }
                } footer: {
                    Text(tr("home_settings.recently_added_mode_hint"))
                }

                Section {
                    Button(tr("home_settings.reset"), role: .destructive) { confirmReset = true }
                }
            }
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
            libraries = (try? await APIClient.shared.get("/api/libraries/mine")) ?? []
            rebuild()
        }
    }

    private var modeBinding: Binding<RecentlyAddedMode> {
        Binding(get: { homeSettings.settings.recentlyAddedMode }, set: { homeSettings.setMode($0) })
    }

    private func rebuild() {
        rows = homeSettings.resolve(libraries: libraries, requestsAllowed: requestsAllowed)
    }

    private func move(_ index: Int, by delta: Int) {
        let target = index + delta
        guard rows.indices.contains(target) else { return }
        rows.swapAt(index, target)
        persist()
    }

    private func setVisible(_ index: Int, _ visible: Bool) {
        let r = rows[index]
        rows[index] = ResolvedHomeSection(key: r.key, type: r.type, visible: visible,
                                           libraryId: r.libraryId, libraryName: r.libraryName)
        persist()
    }

    private func persist() {
        homeSettings.setOrder(rows.map { HomeSectionPref(key: $0.key, visible: $0.visible) })
    }
}

/// One reorderable zone row: label + ↑/↓ (disabled at the edges) + visibility toggle.
private struct HomeLayoutRow: View {
    let row: ResolvedHomeSection
    let isFirst: Bool
    let isLast: Bool
    var onMoveUp: () -> Void
    var onMoveDown: () -> Void
    var onToggleVisible: (Bool) -> Void

    var body: some View {
        HStack(spacing: 24) {
            Text(label).lineLimit(1)
            Spacer()
            Button(action: onMoveUp) { Image(systemName: "chevron.up") }
                .disabled(isFirst)
                .accessibilityLabel(tr("home_settings.move_up"))
            Button(action: onMoveDown) { Image(systemName: "chevron.down") }
                .disabled(isLast)
                .accessibilityLabel(tr("home_settings.move_down"))
            Toggle(tr("home_settings.toggle_visible"), isOn: Binding(get: { row.visible }, set: onToggleVisible))
                .labelsHidden()
        }
    }

    private var label: String {
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
