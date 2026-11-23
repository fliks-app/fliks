import SwiftUI

/// The left navigation rail, the tvOS side of the client's `app-nav-rail`: icons at rest over the page,
/// labels while focus is inside. Entries switch the page under it; its focus lives in RootView.
struct NavRail: View {
    static let collapsedWidth: CGFloat = 140
    private static let expandedWidth: CGFloat = 440
    private static let shownLibraries = 3

    @Binding var path: [Route]
    var focus: FocusState<String?>.Binding
    /// An entry opened its page: focus goes to that page's default.
    var onPage: () -> Void

    @Environment(AuthService.self) private var auth
    @Environment(LibraryStore.self) private var libraryStore
    @State private var music = MusicPlayer.shared
    @State private var showAllLibraries = false
    @State private var accountActions = false

    private var expanded: Bool { focus.wrappedValue != nil }

    /// The entry of the page on screen: the first route of the stack, Home under it.
    private var current: String {
        switch path.first {
        case .search: "search"
        case let .library(id): "lib:\(id)"
        case .playlists: "playlists"
        case .settings: "settings"
        case .nowPlaying: "nowPlaying"
        default: "home"
        }
    }

    private var libraries: [Library] {
        let all = libraryStore.visible
        let currentPastFirst = all.dropFirst(Self.shownLibraries).contains { "lib:\($0.id)" == current }
        return showAllLibraries || currentPastFirst ? all : Array(all.prefix(Self.shownLibraries))
    }

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 6) {
                row("home", tr("nav.home"), "house") { go([]) }
                row("search", tr("sidebar.search"), "magnifyingglass") { go([.search]) }
                if !libraryStore.visible.isEmpty {
                    sectionTitle(tr("nav.section_library"))
                    ForEach(libraries) { lib in
                        row("lib:\(lib.id)", lib.name, lib.symbol) { go([.library(id: lib.id)]) }
                    }
                    if libraryStore.visible.count > Self.shownLibraries, libraries.count <= Self.shownLibraries {
                        row("more", tr("nav.more"), "ellipsis") { showAllLibraries = true }
                    }
                }
                row("playlists", tr("sidebar.playlists"), "list.and.film") { go([.playlists]) }
                Spacer(minLength: 40)
                if let track = music.current {
                    row("nowPlaying", tr("sidebar.now_playing"), music.isPlaying ? "waveform" : "music.note") {
                        if !MusicPlayer.shared.nowPlayingOpen { go([.nowPlaying]) }
                    }
                    .accessibilityHint(track.title)
                }
                row("settings", tr("common.settings"), "gearshape") { go([.settings]) }
                row("account", auth.currentUser?.username ?? "", "person.crop.circle.fill") { accountActions = true }
            }
            .padding(.vertical, 60)
            .padding(.horizontal, 30)
            .frame(minHeight: 1080, alignment: .top)
        }
        .scrollClipDisabled()
        .frame(width: expanded ? Self.expandedWidth : Self.collapsedWidth, alignment: .leading)
        .background(alignment: .leading) {
            LinearGradient(colors: [.black.opacity(0.85), .black.opacity(0.6), .clear], startPoint: .leading, endPoint: .trailing)
                .frame(width: Self.expandedWidth + 260)
                .opacity(expanded ? 1 : 0)
                .allowsHitTesting(false)
        }
        .ignoresSafeArea()
        .focusSection()
        // Entering the rail lands on the page's entry, wherever focus came from.
        .onChange(of: focus.wrappedValue) { old, new in
            if old == nil, let new, new != current { focus.wrappedValue = current }
            if new == nil { showAllLibraries = false }
        }
        .animation(.easeOut(duration: 0.2), value: expanded)
        .accessibilityLabel(tr("nav.rail_label"))
        .confirmationDialog(auth.currentUser?.username ?? "", isPresented: $accountActions, titleVisibility: .visible) {
            Button(tr("sidebar.switch_user")) { auth.switchUser() }
            Button(tr("root.sign_out"), role: .destructive) { Task { await auth.logout() } }
            Button(tr("common.cancel"), role: .cancel) {}
        }
        .task { await libraryStore.load() }
    }

    private func go(_ stack: [Route]) {
        path = stack
        onPage()
    }

    private func sectionTitle(_ title: String) -> some View {
        Text(title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .padding(.horizontal, 20)
            .padding(.top, 18)
            .frame(height: 50, alignment: .bottomLeading)
            .opacity(expanded ? 1 : 0)
    }

    private func row(_ key: String, _ label: String, _ icon: String, action: @escaping () -> Void) -> some View {
        RailRow(label: label, icon: icon, key: key, current: key == current, expanded: expanded, focus: focus,
                action: action)
    }
}

/// Focus = white pill and black text; the page's entry keeps a marker while the rail rests.
private struct RailRow: View {
    let label: String
    let icon: String
    let key: String
    let current: Bool
    let expanded: Bool
    var focus: FocusState<String?>.Binding
    var action: () -> Void

    private var focused: Bool { focus.wrappedValue == key }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 22) {
                Image(systemName: icon)
                    .font(.system(size: 30, weight: current ? .bold : .regular))
                    .frame(width: 40)
                Text(label)
                    .font(.body.weight(current ? .semibold : .regular))
                    .lineLimit(1)
                    .opacity(expanded ? 1 : 0)
            }
            .foregroundStyle(focused ? Color.black : Color.white.opacity(current || expanded ? 1 : 0.7))
            .shadow(color: focused ? .clear : .black.opacity(0.6), radius: 6)
            .padding(.vertical, 14)
            .padding(.horizontal, 20)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(alignment: .leading) {
                if focused {
                    RoundedRectangle(cornerRadius: 14).fill(.white)
                } else if current {
                    Capsule().fill(.white).frame(width: 5, height: 30).offset(x: -14)
                }
            }
        }
        .buttonStyle(RailButtonStyle())
        .scaleEffect(focused ? 1.04 : 1)
        .focused(focus, equals: key)
        .accessibilityLabel(label)
        .accessibilityAddTraits(current ? .isSelected : [])
    }
}

private struct RailButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.7 : 1)
    }
}
