import SwiftUI

/// Every visible library, opened by the rail's "more" entry.
struct LibrariesView: View {
    var onSelect: (Int) -> Void
    @Environment(LibraryStore.self) private var libraryStore

    var body: some View {
        ScrollView {
            ContentGrid(title: tr("home.libraries"), items: libraryStore.visible, columns: 4) { lib in
                LibraryTile(library: lib) { onSelect(lib.id) }
            }
            .padding(.horizontal, 60)
            .padding(.vertical, 48)
        }
        .task { await libraryStore.load() }
    }
}
