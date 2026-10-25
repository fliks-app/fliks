import SwiftUI

/// Scrolling, padded container: the focus lift and shadow of a row never reach the edge of the sheet.
private struct PartySheetPage<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 32) {
                Text(title).font(.title2.bold())
                content
            }
            .frame(maxWidth: 1100, alignment: .leading)
            .padding(.horizontal, 90)
            .padding(.vertical, 70)
            .frame(maxWidth: .infinity)
        }
    }
}

/// Who is in the party and who can still be invited. The host picks from the users they follow.
struct PartyInviteView: View {
    @Environment(PartyService.self) private var service
    @State private var following: [SocialUser] = []
    @State private var picked = Set<Int>()

    var body: some View {
        PartySheetPage(title: tr("party.invite")) {
            if let party = service.party {
                VStack(alignment: .leading, spacing: 14) {
                    Text(tr("party.people")).font(.headline).foregroundStyle(.secondary)
                    ForEach(PartyPeople.people(host: party.host, guests: party.guests ?? [], members: service.members)) { person in
                        HStack {
                            Text(person.username)
                            Spacer()
                            Text(label(person)).foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 8)
                    }
                }
                if service.isHost { candidates(party) }
            }
        }
        .task {
            await service.reload()
            if let me = AuthService.shared.currentUser?.id,
               let list: [SocialUser] = try? await APIClient.shared.get("/api/social/users/\(me)/following") {
                following = list
            }
        }
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

    @ViewBuilder private func candidates(_ party: Party) -> some View {
        let list = PartyPeople.candidates(following: following, host: party.host, guests: party.guests ?? [])
        VStack(alignment: .leading, spacing: 20) {
            Text(tr("party.create_invitees")).font(.headline).foregroundStyle(.secondary)
            if list.isEmpty { Text(tr("party.no_followed")).foregroundStyle(.secondary) }
            ForEach(list) { user in
                Button {
                    if picked.contains(user.id) { picked.remove(user.id) } else { picked.insert(user.id) }
                } label: {
                    HStack {
                        Text(user.username)
                        Spacer()
                        Image(systemName: picked.contains(user.id) ? "checkmark.circle.fill" : "circle")
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
            if !list.isEmpty {
                Button(tr("party.invite")) {
                    let ids = Array(picked)
                    picked = []
                    Task { await service.invite(ids) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(picked.isEmpty)
            }
        }
    }
}

/// The party switches: editable by the host, read-only for members, plus the host's link and end actions.
struct PartySettingsView: View {
    @Environment(PartyService.self) private var service
    @State private var confirmRegenerate = false
    @State private var confirmEnd = false

    var body: some View {
        PartySheetPage(title: tr("party.settings")) {
            if let party = service.party {
                VStack(alignment: .leading, spacing: 24) {
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
                }
                if service.isHost { hostActions(party) } else {
                    Text(tr("party.tv_host_only_hint")).font(.callout).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func toggle(_ label: String, _ value: Bool, _ set: @escaping (Bool) async -> Void) -> some View {
        Toggle(label, isOn: Binding(get: { value }, set: { v in Task { await set(v) } }))
            .disabled(!service.isHost)
    }

    @ViewBuilder private func hostActions(_ party: Party) -> some View {
        VStack(alignment: .leading, spacing: 24) {
            Button(tr("party.regenerate_link")) { confirmRegenerate = true }
                .buttonStyle(.bordered)
                .confirmationDialog(tr("party.regenerate_title"), isPresented: $confirmRegenerate, titleVisibility: .visible) {
                    Button(tr("party.regenerate_link")) { Task { await service.regenerateLink() } }
                    Button(tr("common.cancel"), role: .cancel) {}
                } message: { Text(tr("party.regenerate_message")) }
            Button(tr("party.cancel"), role: .destructive) { confirmEnd = true }
                .buttonStyle(.bordered)
                .confirmationDialog(tr("party.cancel_title"), isPresented: $confirmEnd, titleVisibility: .visible) {
                    Button(tr("party.cancel"), role: .destructive) { Task { await service.endParty() } }
                    Button(tr("common.cancel"), role: .cancel) {}
                } message: { Text(trp("party.cancel_message", ["name": party.name])) }
        }
    }
}
