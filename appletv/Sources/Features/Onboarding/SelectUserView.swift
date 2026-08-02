import SwiftUI

/// Pre-login user picker. An account with a session stored on this device
/// signs straight back in; anything else opens a sheet offering quick connect
/// (recommended, code-less) or password sign-in.
struct SelectUserView: View {
    @Binding var path: NavigationPath
    @Environment(ServerStore.self) private var server
    @Environment(AuthService.self) private var auth

    @State private var serverUsers: [PublicUser] = []
    @State private var loading = true
    @State private var loadError = false
    @State private var notice: String?
    @State private var resuming: Int?
    @State private var openSheetFor: PublicUser?

    /// The server's roster plus the accounts stored here: the union is what
    /// keeps sign-in possible while the server is unreachable.
    private var users: [PublicUser] {
        var byId: [Int: PublicUser] = [:]
        for session in auth.resumableSessions {
            byId[session.user.id] = PublicUser(id: session.user.id,
                                               username: session.user.username,
                                               avatar: session.user.avatar)
        }
        for user in serverUsers { byId[user.id] = user }
        return byId.values.sorted { $0.username.localizedCaseInsensitiveCompare($1.username) == .orderedAscending }
    }

    private var resumableIds: Set<Int> { Set(auth.resumableSessions.map(\.user.id)) }

    var body: some View {
        VStack(spacing: 40) {
            Text(tr("select_user.title")).font(.system(size: 48, weight: .bold))

            if loading {
                ProgressView()
            } else if loadError && users.isEmpty {
                VStack(spacing: 16) {
                    Text(tr("select_user.load_error"))
                    Button(tr("common.retry")) { Task { await load() } }
                }
            } else {
                if loadError {
                    Text(tr("select_user.offline_hint")).foregroundStyle(.secondary)
                }
                if let notice {
                    Text(notice).foregroundStyle(.orange)
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 44) {
                        ForEach(users) { user in
                            UserTile(user: user,
                                     resumable: resumableIds.contains(user.id),
                                     busy: resuming == user.id) {
                                Task { await select(user) }
                            }
                        }
                    }
                    .padding(.horizontal, 60)
                    .padding(.vertical, 40)
                }
            }

            HStack(spacing: 32) {
                Button(tr("select_user.other_user")) { path.append(Route.login(username: nil)) }
                Button(tr("select_user.change_server")) { server.clear() }
            }
        }
        .padding(60)
        .task { await load() }
        .sheet(item: $openSheetFor) { user in
            UserActionSheet(
                user: user,
                onQuickConnect: {
                    openSheetFor = nil
                    path.append(Route.quickConnect(userId: user.id, username: user.username))
                },
                onPassword: {
                    openSheetFor = nil
                    path.append(Route.login(username: user.username))
                }
            )
        }
    }

    private func select(_ user: PublicUser) async {
        guard resuming == nil else { return }
        notice = nil
        guard resumableIds.contains(user.id) else {
            openSheetFor = user
            return
        }
        // The tile stays enabled while resuming: disabling it would drop focus,
        // and a remote has nowhere to go from a focusless screen.
        resuming = user.id
        let outcome = await auth.resumeSession(userId: user.id)
        resuming = nil
        switch outcome {
        case .resumed: break
        case .unreachable: notice = tr("error.network")
        case .expired:
            notice = tr("select_user.session_expired")
            openSheetFor = user
        }
    }

    private func load() async {
        loading = true
        loadError = false
        do {
            serverUsers = try await APIClient.shared.get("/api/auth/users-public")
        } catch {
            loadError = true
        }
        loading = false
    }
}

/// No system focus decoration (no scale, no highlight card) — the tile draws
/// its own focus ring.
private struct RingTileStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.85 : 1)
    }
}

private struct UserTile: View {
    let user: PublicUser
    var resumable = false
    var busy = false
    var action: () -> Void
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 16) {
            Button(action: action) {
                avatarView
                    .frame(width: 180, height: 180)
                    .clipShape(Circle())
                    .overlay { if busy { spinner } }
                    .overlay(alignment: .bottomTrailing) { if resumable && !busy { sessionBadge } }
                    .overlay(Circle().strokeBorder(.white, lineWidth: focused ? 6 : 0))
            }
            .buttonStyle(RingTileStyle())
            .focused($focused)
            Text(user.username)
                .font(.headline)
                .fontWeight(focused ? .semibold : .regular)
                .foregroundStyle(focused ? .primary : .secondary)
                .lineLimit(1)
        }
        .frame(width: 220)
        .animation(.easeOut(duration: 0.15), value: focused)
    }

    private var spinner: some View {
        ZStack {
            Circle().fill(.black.opacity(0.5))
            ProgressView().controlSize(.large)
        }
    }

    private var sessionBadge: some View {
        Image(systemName: "checkmark.circle.fill")
            .font(.system(size: 40))
            .symbolRenderingMode(.palette)
            .foregroundStyle(.white, .green)
            .offset(x: -6, y: -6)
    }

    @ViewBuilder private var avatarView: some View {
        if let url = ImageURL.build(user.avatar, size: .thumb) {
            CachedAsyncImage(url: url) { placeholder }
        } else {
            placeholder
        }
    }

    private var placeholder: some View {
        let (initials, hue) = Self.initialsAvatar(user.username)
        return ZStack {
            Color(hue: hue / 360, saturation: 0.55, brightness: 0.55)
            Text(initials).font(.system(size: 48, weight: .bold)).foregroundStyle(.white)
        }
    }

    /// Deterministic initials + hue from a name — mirrors the Angular
    /// `initialsAvatar` helper so the same user gets the same color everywhere.
    private static func initialsAvatar(_ name: String) -> (initials: String, hue: Double) {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return ("?", 0) }
        let parts = trimmed.split(separator: " ").prefix(2)
        let initials = parts.compactMap(\.first).map(String.init).joined().uppercased()
        var hash: UInt32 = 2166136261
        for scalar in trimmed.unicodeScalars {
            hash ^= scalar.value
            hash = hash &* 16777619
        }
        return (initials.isEmpty ? "?" : initials, Double(hash % 360))
    }
}

/// Per-user action sheet. D-pad focus is trapped inside via `.focusSection()`;
/// quick connect (code-less, recommended) gets default focus.
private struct UserActionSheet: View {
    let user: PublicUser
    var onQuickConnect: () -> Void
    var onPassword: () -> Void
    @Namespace private var focusNamespace

    var body: some View {
        VStack(spacing: 24) {
            Text(user.username).font(.title.bold())

            Button(action: onQuickConnect) {
                Label(tr("select_user.quick_connect"), systemImage: "qrcode")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .prefersDefaultFocus(true, in: focusNamespace)

            Button(action: onPassword) {
                Label(tr("select_user.use_password"), systemImage: "key")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
        }
        .padding(60)
        .frame(maxWidth: 700)
        .focusScope(focusNamespace)
        .focusSection()
    }
}
