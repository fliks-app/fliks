import SwiftUI

/// Full-screen page: title, content that scrolls, one action bar at the bottom. Over the shell backdrop,
/// like the lobby, with the safe-area padding of a tvOS screen.
struct PartySheetPage<Content: View, Bar: View>: View {
    let title: String
    @ViewBuilder var content: Content
    @ViewBuilder var bar: Bar

    var body: some View {
        VStack(spacing: 36) {
            Text(title).font(.largeTitle.bold())
            content.frame(maxWidth: .infinity, maxHeight: .infinity)
            bar
        }
        .padding(.horizontal, 100)
        .padding(.top, 70)
        .padding(.bottom, 60)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black.opacity(0.6))
        .shellBackdrop()
    }
}

private let tileColumns = [GridItem(.adaptive(minimum: 200, maximum: 240), spacing: 30, alignment: .top)]

private struct TileSection<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .center, spacing: 8) {
            Text(title).font(.headline).foregroundStyle(.secondary)
            ScrollView {
                LazyVGrid(columns: tileColumns, alignment: .center, spacing: 30) { content }
                    .padding(.horizontal, 30)
                    .padding(.vertical, 30)
            }
        }
    }
}

/// Who is in the party (left) and who can still be invited (right, host only).
struct PartyInviteView: View {
    @Environment(PartyService.self) private var service
    @State private var following: [SocialUser] = []
    @State private var picked = Set<Int>()
    @Namespace private var focusScope

    private var candidateList: [SocialUser] {
        guard let party = service.party, service.isHost else { return [] }
        return PartyPeople.candidates(following: following, host: party.host, guests: party.guests ?? [])
    }

    var body: some View {
        PartySheetPage(title: tr("party.invite")) {
            if let party = service.party {
                HStack(alignment: .top, spacing: 60) {
                    TileSection(title: tr("party.people")) {
                        ForEach(PartyPeople.people(host: party.host, guests: party.guests ?? [], members: service.members)) { person in
                            AvatarTile(name: person.username, caption: label(person), dimmed: !person.present)
                        }
                    }
                    if service.isHost {
                        TileSection(title: tr("party.create_invitees")) {
                            if candidateList.isEmpty {
                                Text(tr("party.no_followed")).foregroundStyle(.secondary)
                            }
                            ForEach(Array(candidateList.enumerated()), id: \.element.id) { index, user in
                                AvatarTile(name: user.username, selected: picked.contains(user.id)) {
                                    if picked.contains(user.id) { picked.remove(user.id) } else { picked.insert(user.id) }
                                }
                                .prefersDefaultFocus(index == 0, in: focusScope)
                            }
                        }
                        .focusSection()
                    }
                }
            }
        } bar: {
            VStack(spacing: 14) {
                HStack(spacing: 30) {
                    if service.isHost, !candidateList.isEmpty {
                        Button(action: send) {
                            Text(picked.isEmpty ? tr("party.invite") : "\(tr("party.invite")) (\(picked.count))")
                        }
                        .buttonStyle(.borderedProminent)
                        .opacity(picked.isEmpty ? 0.5 : 1)
                    }
                    Button(tr("party.tv_close")) { service.sheet = nil }
                        .buttonStyle(.bordered)
                        .prefersDefaultFocus(candidateList.isEmpty, in: focusScope)
                }
                if service.isHost, !candidateList.isEmpty, picked.isEmpty {
                    Text(tr("party.tv_invite_hint")).font(.callout).foregroundStyle(.secondary)
                }
            }
            .focusSection()
        }
        .focusScope(focusScope)
        .task {
            await service.reload()
            if let me = AuthService.shared.currentUser?.id,
               let list: [SocialUser] = try? await APIClient.shared.get("/api/social/users/\(me)/following") {
                following = list
            }
        }
    }

    private func send() {
        guard !picked.isEmpty else { return service.show(tr("party.tv_invite_hint")) }
        let ids = Array(picked)
        picked = []
        Task { await service.invite(ids) }
    }

    private func label(_ person: PartyPeople.Person) -> String {
        let base: String
        switch person.kind {
        case .host: return tr("party.host_badge")
        case .invited: base = tr("party.person_invited")
        case .link: base = tr("party.person_link")
        }
        return person.present ? base : "\(base) · \(tr("party.person_absent"))"
    }
}

/// The party switches: editable by the host, read-only for members, plus the host's link and end actions.
struct PartySettingsView: View {
    @Environment(PartyService.self) private var service
    @State private var confirmRegenerate = false
    @State private var confirmEnd = false

    var body: some View {
        PartySheetPage(title: tr("party.settings")) {
            ScrollView {
                if let party = service.party {
                    VStack(alignment: .leading, spacing: 28) {
                        toggle(tr("party.switch_playback_control"), party.policy != "host_only") {
                            await service.updateSettings(policy: $0 ? "everyone" : "host_only")
                        }
                        toggle(tr("party.switch_reactions"), party.reactionsEnabled ?? true) {
                            await service.updateSettings(reactionsEnabled: $0)
                        }
                        toggle(tr("party.switch_chat"), party.chatEnabled ?? true) { await service.updateSettings(chatEnabled: $0) }
                        toggle(tr("party.switch_link_sharing"), party.linkSharing ?? true) {
                            await service.updateSettings(linkSharing: $0)
                        }
                        if !service.isHost {
                            Text(tr("party.tv_host_only_hint")).font(.callout).foregroundStyle(.secondary)
                        }
                    }
                    .frame(maxWidth: 1000)
                    .padding(30)
                    .frame(maxWidth: .infinity)
                }
            }
        } bar: {
            HStack(spacing: 30) {
                if service.isHost {
                    Button(tr("party.regenerate_link")) { confirmRegenerate = true }
                        .buttonStyle(.bordered)
                        .confirmationDialog(tr("party.regenerate_title"), isPresented: $confirmRegenerate, titleVisibility: .visible) {
                            Button(tr("party.regenerate_link")) { Task { await service.regenerateLink() } }
                            Button(tr("common.cancel"), role: .cancel) {}
                        } message: { Text(tr("party.regenerate_message")) }
                    Button(tr("party.cancel")) { confirmEnd = true }
                        .buttonStyle(DestructiveButtonStyle())
                        .confirmationDialog(tr("party.cancel_title"), isPresented: $confirmEnd, titleVisibility: .visible) {
                            Button(tr("party.cancel"), role: .destructive) { Task { await service.endParty() } }
                            Button(tr("common.cancel"), role: .cancel) {}
                        } message: { Text(trp("party.cancel_message", ["name": service.party?.name ?? ""])) }
                }
                Button(tr("party.tv_close")) { service.sheet = nil }
                    .buttonStyle(.bordered)
            }
            .focusSection()
        }
    }

    private func toggle(_ label: String, _ value: Bool, _ set: @escaping (Bool) async -> Void) -> some View {
        Toggle(label, isOn: Binding(get: { value }, set: { v in Task { await set(v) } }))
            .disabled(!service.isHost)
    }
}
