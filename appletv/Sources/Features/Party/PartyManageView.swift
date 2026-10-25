import SwiftUI

/// Settings, people and invitations of the joined party. The host edits; members see the same values read-only.
struct PartyManageView: View {
    @Environment(PartyService.self) private var service
    @State private var following: [SocialUser] = []
    @State private var picked = Set<Int>()
    @State private var confirmRegenerate = false
    @State private var confirmEnd = false

    var body: some View {
        List {
            if let party = service.party {
                settings(party)
                people(party)
                if service.isHost { invite(party) }
                link(party)
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

    private func toggle(_ label: String, _ value: Bool, _ set: @escaping (Bool) async -> Void) -> some View {
        Toggle(label, isOn: Binding(get: { value }, set: { v in Task { await set(v) } }))
            .disabled(!service.isHost)
    }

    @ViewBuilder private func settings(_ party: Party) -> some View {
        Section(tr("party.settings")) {
            toggle(tr("party.switch_playback_control"), party.policy != "host_only") {
                await service.updateSettings(policy: $0 ? "everyone" : "host_only")
            }
            toggle(tr("party.switch_reactions"), party.reactionsEnabled ?? true) {
                await service.updateSettings(reactionsEnabled: $0)
            }
            toggle(tr("party.switch_chat"), party.chatEnabled ?? true) { await service.updateSettings(chatEnabled: $0) }
            toggle(tr("party.switch_link_sharing"), party.linkSharing ?? true) { await service.updateSettings(linkSharing: $0) }
            if !service.isHost {
                Text(tr("party.tv_host_only_hint")).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder private func people(_ party: Party) -> some View {
        Section(tr("party.people")) {
            ForEach(PartyPeople.people(host: party.host, guests: party.guests ?? [], members: service.members)) { person in
                HStack {
                    Text(person.username)
                    Spacer()
                    Text(label(person)).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func label(_ person: PartyPeople.Person) -> String {
        switch person.kind {
        case .host: return tr("party.host_badge")
        case .invited: return person.present ? tr("party.person_invited") : "\(tr("party.person_invited")) · \(tr("party.person_absent"))"
        case .link: return person.present ? tr("party.person_link") : "\(tr("party.person_link")) · \(tr("party.person_absent"))"
        }
    }

    @ViewBuilder private func invite(_ party: Party) -> some View {
        let candidates = PartyPeople.candidates(following: following, host: party.host, guests: party.guests ?? [])
        Section(tr("party.create_invitees")) {
            if candidates.isEmpty {
                Text(tr("party.no_followed")).foregroundStyle(.secondary)
            }
            ForEach(candidates) { user in
                Button {
                    if picked.contains(user.id) { picked.remove(user.id) } else { picked.insert(user.id) }
                } label: {
                    HStack {
                        Text(user.username)
                        Spacer()
                        Image(systemName: picked.contains(user.id) ? "checkmark.circle.fill" : "circle")
                    }
                }
            }
            if !candidates.isEmpty {
                Button(tr("party.invite")) {
                    let ids = Array(picked)
                    picked = []
                    Task { await service.invite(ids) }
                }
                .disabled(picked.isEmpty)
            }
        }
    }

    @ViewBuilder private func link(_ party: Party) -> some View {
        Section(tr("party.link")) {
            if let token = party.inviteToken {
                Text(ServerStore.shared.resolveUrl("/party/\(token)")).font(.callout)
                Text(token).font(.callout.monospaced()).foregroundStyle(.secondary)
            }
            if service.isHost {
                Button(tr("party.regenerate_link")) { confirmRegenerate = true }
                    .confirmationDialog(tr("party.regenerate_title"), isPresented: $confirmRegenerate, titleVisibility: .visible) {
                        Button(tr("party.regenerate_link")) { Task { await service.regenerateLink() } }
                        Button(tr("common.cancel"), role: .cancel) {}
                    } message: { Text(tr("party.regenerate_message")) }
                Button(tr("party.cancel"), role: .destructive) { confirmEnd = true }
                    .confirmationDialog(tr("party.cancel_title"), isPresented: $confirmEnd, titleVisibility: .visible) {
                        Button(tr("party.cancel"), role: .destructive) { Task { await service.endParty() } }
                        Button(tr("common.cancel"), role: .cancel) {}
                    } message: { Text(trp("party.cancel_message", ["name": party.name])) }
            }
        }
    }
}
