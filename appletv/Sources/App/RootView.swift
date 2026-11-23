import SwiftUI

/// Onboarding gate: not-configured -> setup, configured+signed-out -> user
/// picker (+ quick-connect/login routes), signed-in -> the real app shell
/// (sidebar + Home + detail routes), keeping P2's gate intact.
struct RootView: View {
    @State private var auth = AuthService.shared
    @State private var server = ServerStore.shared
    @State private var wasBackgrounded = false
    @State private var settings = AppSettingsStore.shared
    @State private var locale = LocaleStore.shared
    @State private var homeSettings = HomeSettingsStore.shared
    @State private var backdrop = Backdrop()
    @State private var homeRefresh = HomeRefresh.shared
    @State private var watched = WatchedStore.shared
    @State private var libraryStore = LibraryStore.shared
    @State private var playlistPicker = PlaylistPicker.shared
    @State private var party = PartyService.shared
    @State private var remote = RemoteControlService.shared
    @State private var toasts = NotificationToastService.shared
    @State private var path: [Route] = []
    @FocusState private var railFocus: String?
    /// Off while focus is handed to the page: a focusable rail would win the focus engine's pick.
    @State private var railEnabled = false
    @Namespace private var shell
    @Environment(\.resetFocus) private var resetFocus
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        content
            .overlay(alignment: .bottom) { PartyNotice() }
            .task {
                if server.isConfigured { await auth.bootstrap() }
            }
            .task(id: auth.state) {
                if auth.state == .signedIn { await watched.loadOverview() }
                updateRemotePolling()
                updateToastStream()
            }
            .task(id: homeRefresh.tick) {
                if auth.state == .signedIn { await watched.loadOverview() }
            }
            .onChange(of: scenePhase) { _, new in
                updateRemotePolling()
                updateToastStream()
                if new == .background { wasBackgrounded = true }
                // A wake goes background, inactive, active: what moved meanwhile (the phone's progress, the server's version) shows now.
                if new == .active, wasBackgrounded {
                    wasBackgrounded = false
                    if auth.state == .signedIn {
                        homeRefresh.bump()
                        Task { await ServerVersion.shared.refresh() }
                    }
                }
            }
            .onChange(of: locale.lang) { _, _ in
                toasts.stop()
                updateToastStream()
            }
            .onChange(of: party.active) { _, active in if !active { MusicPartyDriver.shared.detach() } }
            .onAppear {
                ToastWindow.shared.install(service: toasts)
                RemoteControlService.shared.onLoadRequested = { mediaFileId, mediaId, episodeId, startAt, startPaused, tracks in
                    // Same "reset then push" the auth-state transition above uses -
                    // a remote `load` always replaces whatever is on screen.
                    path = []
                    path.append(Route.player(mediaFileId: mediaFileId, mediaId: mediaId,
                                              episodeId: episodeId, startAt: startAt, startPaused: startPaused,
                                              launch: tracks))
                }
                RemoteControlService.shared.onOpenMusic = {
                    path = []
                    path.append(Route.nowPlaying)
                }
                party.onOpenLobby = { _ in path.append(Route.partyLobby) }
                party.onGoHome = { path = [] }
                party.onOpenMusic = {
                    MusicPartyDriver.shared.attach()
                    if !MusicPlayer.shared.nowPlayingOpen { path.append(Route.nowPlaying) }
                }
                party.onOpenPlayer = { mediaFileId, mediaId, episodeId in
                    path.append(Route.player(mediaFileId: mediaFileId, mediaId: mediaId, episodeId: episodeId, startAt: 0))
                }
            }
            .fullScreenCover(item: Binding(get: { party.sheet }, set: { party.sheet = $0 })) { sheet in
                Group {
                    switch sheet {
                    case .invite: PartyInviteView()
                    case .settings: PartySettingsView()
                    case .chat: PartyChatView()
                    case .propose: PartyProposeView()
                    case .create: PartyCreateView()
                    case .programme: PartyProgrammeView()
                    }
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
                    path = []
                }
            }
            .onChange(of: path.count) { _, count in
                // Back at the Home root — refetch dynamic zones so they reflect
                // anything that changed behind a pushed screen (e.g. playback).
                if count == 0 { homeRefresh.bump() }
            }
            // After the presentations: a cover or sheet only inherits the environment set outside it.
            .environment(auth)
            .environment(server)
            .environment(settings)
            .environment(locale)
            .environment(homeSettings)
            .environment(backdrop)
            .environment(homeRefresh)
            .environment(watched)
            .environment(libraryStore)
            .environment(playlistPicker)
            .environment(party)
            .id(locale.lang)
    }

    /// The player and the music screen take the whole screen.
    private var railShown: Bool {
        switch path.last {
        case .player, .nowPlaying: false
        default: true
        }
    }

    /// Back to the page item focus came from, else to the page's default.
    private func leaveRail() {
        Task { await handFocusToPage() }
    }

    /// Focus goes to the page's default item; the rail is disabled meanwhile, or it would win that pick.
    private func handFocusToPage(after delay: Duration = .zero) async {
        railEnabled = false
        // A page the rail just opened needs its push to land first.
        if delay > .zero { try? await Task.sleep(for: delay) }
        resetFocus(in: shell)
        try? await Task.sleep(for: .milliseconds(400))
        railEnabled = true
    }

    /// Inactive (Siri, system overlays) keeps the stream: only a background stops it.
    private func updateToastStream() {
        if scenePhase != .background, auth.state == .signedIn { toasts.start() } else { toasts.stop() }
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
            ZStack(alignment: .leading) {
                NavigationStack(path: $path) {
                    HomeView(
                        onSelectMedia: { path.append(Route.mediaDetail(id: $0)) },
                        onSelectEpisode: { path.append(Route.episodeDetail(mediaId: $0, episodeId: $1)) },
                        onSelectLibrary: { path.append(Route.library(id: $0)) },
                        onSelectPlaylist: { path.append(Route.playlistDetail(id: $0)) },
                        onSelectParty: { path.append(Route.partyDetail(id: $0)) },
                        onPlay: { path.append(Route.player(mediaFileId: $0, mediaId: $1, episodeId: $2, startAt: nil)) },
                        onCustomize: { path.append(Route.homeLayout) }
                    )
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    // Back on Home shows the rail first, then leaves the app (the system's own Back from the rail).
                    .onExitCommand(perform: railFocus == nil ? { railFocus = "home" } : nil)
                    // Backdrop as a background (not a ZStack sibling) so a loading/
                    // changing image can never resize the shell.
                    .backgroundPreferenceValue(HeroScrollKey.self) {
                        BackdropView(backdrop: backdrop, heroScroll: $0).ignoresSafeArea()
                    }
                    .navigationDestination(for: Route.self) { route in
                        Group {
                        switch route {
                        case .libraries:
                            LibrariesView(onSelect: { path.append(Route.library(id: $0)) })
                        case let .library(id):
                            LibraryView(libraryId: id, onSelectMedia: { path.append(Route.forMedia($0, $1)) },
                                        onSelectArtist: { path.append(Route.artist(id: $0)) },
                                        onPlay: { path.append(Route.player(mediaFileId: $0, mediaId: $1, episodeId: $2,
                                                                           startAt: nil)) })
                        case let .mediaDetail(id):
                            MediaDetailView(
                                mediaId: id,
                                onPlay: { mediaFileId, episodeId, startAt in
                                    path.append(Route.player(mediaFileId: mediaFileId, mediaId: id,
                                                              episodeId: episodeId, startAt: startAt))
                                },
                                onSelectEpisode: { path.append(Route.episodeDetail(mediaId: id, episodeId: $0)) },
                                onAlbum: {
                                    if !path.isEmpty { path.removeLast() }
                                    path.append(Route.album(id: id))
                                }
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
                        case let .album(id):
                            AlbumView(mediaId: id, onSelectArtist: { path.append(Route.artist(id: $0)) })
                        case let .artist(id):
                            ArtistView(personId: id, onSelectAlbum: { path.append(Route.album(id: $0)) })
                        case .nowPlaying:
                            NowPlayingView(onClose: { if !path.isEmpty { path.removeLast() } },
                                           onSelectAlbum: { path.append(Route.album(id: $0)) },
                                           onSelectArtist: { path.append(Route.artist(id: $0)) })
                        case let .player(mediaFileId, mediaId, episodeId, startAt, startPaused, launch):
                            PlayerView(
                                mediaFileId: mediaFileId, mediaId: mediaId, episodeId: episodeId, startAt: startAt,
                                startPaused: startPaused, launch: launch,
                                onExit: { if !path.isEmpty { path.removeLast() } }
                            )
                            .onAppear { MusicPlayer.shared.stop() }
                        case .search:
                            SearchView(onSelectMedia: { path.append(Route.forMedia($0, $1)) },
                                       onSelectArtist: { path.append(Route.artist(id: $0)) })
                        case .playlists:
                            PlaylistsView(onSelectPlaylist: { path.append(Route.playlistDetail(id: $0)) })
                        case let .playlistDetail(id):
                            PlaylistDetailView(playlistId: id, onPlay: { mediaFileId, mediaId, episodeId, startAt in
                                path.append(Route.player(mediaFileId: mediaFileId, mediaId: mediaId,
                                                          episodeId: episodeId, startAt: startAt))
                            })
                        case .partyLobby:
                            PartyLobbyView()
                        case let .partyDetail(id):
                            PartyDetailView(partyId: id)
                        case .settings:
                            SettingsView()
                        case .homeLayout:
                            HomeLayoutView()
                        default:
                            EmptyView() // onboarding routes never belong in the signed-in stack
                        }
                        }
                        .shellBackdrop()
                    }
                }
                // Added to the system's leading inset, which already covers part of the rail.
                .safeAreaPadding(.leading, railShown ? NavRail.collapsedWidth - 60 : 0)
                .focusSection()
                .overlay {
                    // The open rail dims the page; the page never reflows under it.
                    Color.black.opacity(railFocus == nil ? 0 : 0.35).ignoresSafeArea().allowsHitTesting(false)
                }
                if railShown {
                    NavRail(path: $path, focus: $railFocus,
                            onPage: { Task { await handFocusToPage(after: .milliseconds(500)) } })
                        .disabled(!railEnabled)
                        // The open rail covers the page's left edge, so Right never finds it on its own.
                        .onMoveCommand { if $0 == .right { leaveRail() } }
                        // Back from an open rail returns to the page, except on Home where it leaves the app.
                        .onExitCommand(perform: path.isEmpty ? nil : leaveRail)
                }
            }
            .focusScope(shell)
            .animation(.easeOut(duration: 0.2), value: railFocus == nil)
            .task { await handFocusToPage() }
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
