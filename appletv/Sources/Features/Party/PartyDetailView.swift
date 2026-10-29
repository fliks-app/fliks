import SwiftUI

/// A party seen from the Home before joining: who is in it, and the way in. Joining and playing start here.
struct PartyDetailView: View {
    let partyId: Int
    @Environment(PartyService.self) private var service
    @Environment(Backdrop.self) private var backdrop
    @State private var gone = false
    @State private var fetched: [PartyItem] = []

    private var party: Party? { service.managed?.id == partyId ? service.managed : nil }
    private var programme: [PartyItem] { joined ? service.queue : fetched }
    private var isHost: Bool { party?.host.userId == AuthService.shared.currentUser?.id }
    private var joined: Bool { service.party?.id == partyId }

    var body: some View {
        ScrollView {
            if let party {
                VStack(alignment: .leading, spacing: 44) {
                    PartyHeaderView(party: party)
                    actions(party)
                    PartyProgrammeRail(items: programme, canEdit: isHost)
                    members(party)
                }
                .padding(.horizontal, 60)
                .padding(.vertical, 48)
            } else if gone {
                Text(tr("party.page_gone")).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity).padding(.top, 200)
            } else {
                ProgressView().controlSize(.large).frame(maxWidth: .infinity).padding(.top, 200)
            }
        }
        .onDisappear { service.setPreview(nil) }
        // The party changes under the page (people join, it goes live): keep it current while visible.
        .task {
            while !Task.isCancelled {
                if await service.reload(id: partyId) {
                    if !joined, let items = await service.fetchQueue() { fetched = items }
                    backdrop.url = party?.item?.fanartUrl ?? party?.item?.posterUrl
                } else {
                    gone = true
                    service.setPreview(nil)
                    service.sheet = nil
                    service.onGoHome?()
                }
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }

    private func actions(_ party: Party) -> some View {
        HStack(spacing: 24) {
            Button { Task { await service.enter(id: party.id) } } label: {
                Label(tr("party.join"), systemImage: "play.fill")
            }
            .buttonStyle(.borderedProminent)
            if !joined, PartyPeople.isGuest(AuthService.shared.currentUser?.id, host: party.host, guests: party.guests ?? []) {
                Button { Task { await service.quit(id: party.id) } } label: {
                    Label(tr("party.leave"), systemImage: "xmark")
                }
                .buttonStyle(.bordered)
            }
            if isHost {
                Button { service.sheet = .settings } label: {
                    Label(tr("party.settings"), systemImage: "gearshape")
                }
                .buttonStyle(.bordered)
                EndPartyButton()
            }
            // The host ends the party with the button above; leaving is for members.
            if joined, !isHost {
                Spacer(minLength: 80)
                Button { Task { await service.leaveToHome() } } label: {
                    Label(tr("party.tv_leave"), systemImage: "rectangle.portrait.and.arrow.right")
                }
                .buttonStyle(DestructiveButtonStyle())
            }
        }
        .focusSection()
    }

    private func members(_ party: Party) -> some View {
        let people = PartyPeople.people(host: party.host, guests: party.guests ?? [], members: party.live?.members ?? [])
        return VStack(alignment: .leading, spacing: 10) {
            Text(tr("party.people")).font(.headline).foregroundStyle(.secondary)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 36) {
                    ForEach(people) { person in
                        AvatarTile(name: person.username, caption: person.caption, dimmed: !person.present)
                    }
                    if isHost { AvatarTile(name: tr("party.programme_add"), symbol: "plus") { service.sheet = .invite } }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 24)
            }
            .scrollClipDisabled()
        }
        .focusSection()
    }
}
