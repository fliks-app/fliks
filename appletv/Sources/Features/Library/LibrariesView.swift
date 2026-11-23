import SwiftUI

/// Every visible library, opened by the rail's "more" entry; edit mode reorders and hides them.
struct LibrariesView: View {
    var onSelect: (Int) -> Void
    @Environment(AuthService.self) private var auth
    @Environment(LibraryStore.self) private var libraryStore
    @State private var editing = false

    private var hidden: Set<Int> { Set(auth.currentUser?.hiddenLibraryIds ?? []) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 30) {
                HStack {
                    Text(tr("home.libraries")).font(.title2.bold())
                    Spacer()
                    ControlButton(systemImage: editing ? "checkmark" : "arrow.up.arrow.down",
                                  label: tr(editing ? "common.ok" : "nav.edit_library_order"),
                                  active: editing) { editing.toggle() }
                }
                .focusSection()
                if editing { editor } else {
                    ContentGrid(title: nil, items: libraryStore.visible, columns: 4) { lib in
                        LibraryTile(library: lib) { onSelect(lib.id) }
                    }
                }
            }
            .padding(.horizontal, 60)
            .padding(.vertical, 48)
        }
        .task { await libraryStore.load() }
    }

    private var editor: some View {
        let all = libraryStore.all
        return VStack(alignment: .leading, spacing: 10) {
            Text(tr("home_settings.libraries_hint")).font(.callout).foregroundStyle(.secondary)
            ForEach(Array(all.enumerated()), id: \.element.id) { index, lib in
                let visible = !hidden.contains(lib.id)
                SettingsRow(label: lib.name, icon: lib.symbol, tint: lib.tint, dimmed: !visible) {
                    ControlButton(systemImage: "chevron.up", disabled: index == 0) { move(all, index, by: -1) }
                    ControlButton(systemImage: "chevron.down", disabled: index == all.count - 1) { move(all, index, by: 1) }
                    VisibilityButton(visible: visible) { setVisible(lib.id, !visible) }
                }
            }
        }
        .focusSection()
    }

    private func move(_ all: [Library], _ index: Int, by delta: Int) {
        var ids = all.map(\.id)
        ids.swapAt(index, index + delta)
        auth.setLibraryPrefs(order: ids, hidden: hidden.sorted())
    }

    private func setVisible(_ id: Int, _ visible: Bool) {
        var next = hidden
        if visible { next.remove(id) } else { next.insert(id) }
        auth.setLibraryPrefs(order: libraryStore.all.map(\.id), hidden: next.sorted())
    }
}
