import SwiftUI

/// Onboarding gate: not-configured -> setup, configured+signed-out -> user
/// picker (+ quick-connect/login routes), signed-in -> the real app shell
/// (sidebar + Home + detail routes), keeping P2's gate intact.
struct RootView: View {
    @State private var auth = AuthService.shared
    @State private var server = ServerStore.shared
    @State private var settings = AppSettingsStore.shared
    @State private var locale = LocaleStore.shared
    @State private var homeSettings = HomeSettingsStore.shared
    @State private var backdrop = Backdrop()
    @State private var homeRefresh = HomeRefresh.shared
    @State private var watched = WatchedStore.shared
    @State private var playlistPicker = PlaylistPicker.shared
    @State private var path = NavigationPath()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        content
            .environment(auth)
            .environment(server)
            .environment(settings)
            .environment(locale)
            .environment(homeSettings)
            .environment(backdrop)
            .environment(homeRefresh)
            .environment(watched)
            .environment(playlistPicker)
            .id(locale.lang)
            .task {
                if server.isConfigured { await auth.bootstrap() }
            }
            .task(id: auth.state) {
                if auth.state == .signedIn { await watched.loadOverview() }
                updateRemotePolling()
            }
            .task(id: homeRefresh.tick) {
                if auth.state == .signedIn { await watched.loadOverview() }
            }
            .onChange(of: scenePhase) { _, _ in updateRemotePolling() }
            .onAppear {
                RemoteControlService.shared.onLoadRequested = { mediaFileId, mediaId, episodeId, startAt in
                    // Same "reset then push" the auth-state transition above uses -
                    // a remote `load` always replaces whatever is on screen.
                    path = NavigationPath()
                    path.append(Route.player(mediaFileId: mediaFileId, mediaId: mediaId,
                                              episodeId: episodeId, startAt: startAt))
                }
            }
            .sheet(item: Binding(get: { playlistPicker.target },
                                 set: { playlistPicker.target = $0 })) { target in
                AddToPlaylistSheet(target: target) { playlistPicker.target = nil }
            }
            .onChange(of: auth.state) { _, newState in
                // Both edges start the stack fresh: signing out must not leave
                // an onboarding route behind, and signing in must not carry
                // one of those routes into the main shell's stack.
                if newState == .signedOut || newState == .signedIn {
                    path = NavigationPath()
                }
            }
            .onChange(of: path.count) { _, count in
                // Back at the Home root — refetch dynamic zones so they reflect
                // anything that changed behind a pushed screen (e.g. playback).
                if count == 0 { homeRefresh.bump() }
            }
    }

    /// Poll only while signed in and foregrounded: no point keeping a target
    /// controllable, or hitting the network, once the app is backgrounded.
    private func updateRemotePolling() {
        if scenePhase == .active, auth.state == .signedIn {
            RemoteControlService.shared.startPolling()
        } else {
            RemoteControlService.shared.stopPolling()
        }
    }

    @ViewBuilder private var content: some View {
        if !server.isConfigured {
            ServerSetupView()
        } else if auth.state == .connecting {
            ProgressView()
                .controlSize(.large)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if auth.state == .signedIn {
            NavigationStack(path: $path) {
                HStack(spacing: 0) {
                    Sidebar(path: $path)
                        .frame(width: 380)
                        .focusSection()
                    HomeView(
                        onSelectMedia: { path.append(Route.mediaDetail(id: $0)) },
                        onSelectLibrary: { path.append(Route.library(id: $0)) },
                        onSelectPlaylist: { path.append(Route.playlistDetail(id: $0)) }
                    )
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .focusSection()
                }
                .ignoresSafeArea(edges: .horizontal)
                // Backdrop as a background (not a ZStack sibling) so a loading/
                // changing image can never resize the shell.
                .background { BackdropView(backdrop: backdrop).ignoresSafeArea() }
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    case .home:
                        HomeView(
                            onSelectMedia: { path.append(Route.mediaDetail(id: $0)) },
                            onSelectLibrary: { path.append(Route.library(id: $0)) },
                            onSelectPlaylist: { path.append(Route.playlistDetail(id: $0)) }
                        )
                    case let .library(id):
                        LibraryView(libraryId: id, onSelectMedia: { path.append(Route.mediaDetail(id: $0)) })
                    case let .mediaDetail(id):
                        MediaDetailView(
                            mediaId: id,
                            onPlay: { mediaFileId, episodeId, startAt in
                                path.append(Route.player(mediaFileId: mediaFileId, mediaId: id,
                                                          episodeId: episodeId, startAt: startAt))
                            },
                            onSelectEpisode: { path.append(Route.episodeDetail(mediaId: id, episodeId: $0)) }
                        )
                    case let .episodeDetail(mediaId, episodeId):
                        EpisodeDetailView(
                            mediaId: mediaId,
                            episodeId: episodeId,
                            onPlay: { mediaFileId, epId, startAt in
                                path.append(Route.player(mediaFileId: mediaFileId, mediaId: mediaId,
                                                          episodeId: epId, startAt: startAt))
                            },
                            onSelectEpisode: { path.append(Route.episodeDetail(mediaId: mediaId, episodeId: $0)) }
                        )
                    case let .player(mediaFileId, mediaId, episodeId, startAt):
                        PlayerView(
                            mediaFileId: mediaFileId, mediaId: mediaId, episodeId: episodeId, startAt: startAt,
                            onExit: { if !path.isEmpty { path.removeLast() } }
                        )
                    case .search:
                        SearchView(onSelectMedia: { path.append(Route.mediaDetail(id: $0)) })
                    case .playlists:
                        PlaylistsView(onSelectPlaylist: { path.append(Route.playlistDetail(id: $0)) })
                    case let .playlistDetail(id):
                        PlaylistDetailView(playlistId: id, onPlay: { mediaFileId, mediaId, episodeId, startAt in
                            path.append(Route.player(mediaFileId: mediaFileId, mediaId: mediaId,
                                                      episodeId: episodeId, startAt: startAt))
                        })
                    case .settings:
                        SettingsView()
                    default:
                        EmptyView() // onboarding routes never belong in the signed-in stack
                    }
                }
            }
        } else {
            NavigationStack(path: $path) {
                SelectUserView(path: $path)
                    .navigationDestination(for: Route.self) { route in
                        switch route {
                        case let .quickConnect(userId, username):
                            QuickConnectView(userId: userId, username: username)
                        case let .login(username):
                            LoginView(prefilledUsername: username)
                        default:
                            EmptyView() // main-shell routes are unreachable while signed out
                        }
                    }
            }
        }
    }
}

/// App shell sidebar: search, one entry per accessible library, playlists,
/// settings, and the account row (sign-out). `.focusSection()` (applied by
/// the caller) keeps D-pad moves clean between here and the content pane.
struct Sidebar: View {
    @Binding var path: NavigationPath
    @Environment(AuthService.self) private var auth
    @State private var libraries: [Library] = []
    @FocusState private var focused: String?
    @State private var accountActions = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Image("FliksLogo")
                .resizable()
                .scaledToFit()
                .frame(height: 52)
                .padding(.leading, 16)
                .padding(.bottom, 24)

            SidebarRow(label: tr("sidebar.search"), systemImage: "magnifyingglass", focusID: "search", focused: $focused) {
                path.append(Route.search)
            }

            if !libraries.isEmpty {
                Text(tr("home.libraries"))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 16)
                    .padding(.top, 14)
                    .padding(.bottom, 2)
                ForEach(libraries) { lib in
                    SidebarRow(label: lib.name, systemImage: lib.symbol, focusID: "lib:\(lib.id)",
                               indent: true, focused: $focused) {
                        path.append(Route.library(id: lib.id))
                    }
                }
            }

            SidebarRow(label: tr("sidebar.playlists"), systemImage: "list.and.film", focusID: "playlists", focused: $focused) {
                path.append(Route.playlists)
            }

            Spacer()

            SidebarRow(label: tr("common.settings"), systemImage: "gearshape", focusID: "settings", focused: $focused) {
                path.append(Route.settings)
            }

            SidebarRow(label: auth.currentUser?.username ?? "", systemImage: "person.crop.circle.fill",
                       focusID: "account", focused: $focused) {
                accountActions = true
            }
            .confirmationDialog(auth.currentUser?.username ?? "", isPresented: $accountActions,
                                titleVisibility: .visible) {
                Button(tr("sidebar.switch_user")) { auth.switchUser() }
                Button(tr("root.sign_out"), role: .destructive) { Task { await auth.logout() } }
                Button(tr("common.cancel"), role: .cancel) {}
            }
        }
        .padding(.leading, 44)
        .padding(.trailing, 12)
        .padding(.top, 40)
        .frame(maxHeight: .infinity, alignment: .top)
        .animation(.easeInOut(duration: 0.15), value: focused)
        .task { await loadLibraries() }
    }

    private func loadLibraries() async {
        let all: [Library] = (try? await APIClient.shared.get("/api/libraries/mine")) ?? []
        let hidden = Set(auth.currentUser?.hiddenLibraryIds ?? [])
        libraries = all.filter { !hidden.contains($0.id) }
    }
}

/// A flat, focusable sidebar row: focus = white pill + black text, no system
/// button lift — every row shares the exact same size in all three states
/// (plain / selected-adjacent / focused).
private struct SidebarRow: View {
    let label: String
    let systemImage: String
    let focusID: String
    var indent = false
    var focused: FocusState<String?>.Binding
    var action: () -> Void

    private var isFocused: Bool { focused.wrappedValue == focusID }

    var body: some View {
        Button(action: action) {
            Label(label, systemImage: systemImage)
                .font(.body)
                .foregroundStyle(isFocused ? Color.black : Color.white)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 12)
                .padding(.horizontal, 16)
                .padding(.leading, indent ? 18 : 0)
        }
        .buttonStyle(SidebarButtonStyle())
        .background(RoundedRectangle(cornerRadius: 12).fill(isFocused ? Color.white : Color.clear))
        .scaleEffect(isFocused ? 1.05 : 1.0)
        .focused(focused, equals: focusID)
    }
}

private struct SidebarButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.7 : 1)
    }
}
