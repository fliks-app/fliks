import SwiftUI

/// Pre-login user picker. Selecting a tile opens a sheet offering quick
/// connect (recommended, code-less) or password sign-in for that user.
struct SelectUserView: View {
    @Binding var path: NavigationPath
    @Environment(ServerStore.self) private var server

    @State private var users: [PublicUser] = []
    @State private var loading = true
    @State private var loadError = false
    @State private var openSheetFor: PublicUser?

    var body: some View {
        VStack(spacing: 40) {
            Text(tr("select_user.title")).font(.system(size: 48, weight: .bold))

            if loading {
                ProgressView()
            } else if loadError {
                VStack(spacing: 16) {
                    Text(tr("error.network"))
                    Button(tr("common.retry")) { Task { await load() } }
                }
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 44) {
                        ForEach(users) { user in
                            UserTile(user: user) { openSheetFor = user }
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

    private func load() async {
        loading = true
        loadError = false
        do {
            users = try await APIClient.shared.get("/api/auth/users-public")
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
    var action: () -> Void
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 16) {
            Button(action: action) {
                avatarView
                    .frame(width: 180, height: 180)
                    .clipShape(Circle())
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
