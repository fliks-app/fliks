import SwiftUI

/// A scheduled party's lobby, open from its creation: header, actions, the programme, who is here and the proposals.
struct PartyLobbyView: View {
    @Environment(PartyService.self) private var service
    @Environment(Backdrop.self) private var backdrop
    @Environment(\.dismiss) private var dismiss
    @State private var visible = false
    @State private var selected: PartyMember?
    @State private var selectedGuest: PartyGuest?

    var body: some View {
        ScrollView {
            if let party = service.party {
                VStack(alignment: .leading, spacing: 44) {
                    PartyHeaderView(party: party)
                    actions
                    PartyProgrammeRail(items: service.queue, canEdit: service.isHost)
                    members
                    proposals
                }
                .padding(.horizontal, 60)
                .padding(.vertical, 48)
            }
        }
        // Only the visible lobby pops itself: under the player it would take the player with it.
        .onChange(of: service.party == nil) { _, gone in
            if gone, visible { dismiss() }
        }
        .onAppear {
            visible = true
            if service.party == nil { dismiss() }
            backdrop.url = service.party?.item?.fanartUrl ?? service.party?.item?.posterUrl
        }
        // Going live hands the screen to the player, which owns the party from there.
        .onDisappear {
            visible = false
            if service.lobby { Task { await service.leave() } }
        }
        .confirmationDialog(selected?.username ?? "", isPresented: Binding(get: { selected != nil }, set: { if !$0 { selected = nil } }),
                            titleVisibility: .visible, presenting: selected) { member in
            Button(tr("party.make_host")) { Task { await service.makeHost(member.userId) } }
            Button(tr("party.kick"), role: .destructive) { Task { await service.kick(member.userId) } }
            Button(tr("common.cancel"), role: .cancel) {}
        }
        .confirmationDialog(selectedGuest?.username ?? "", isPresented: Binding(get: { selectedGuest != nil }, set: { if !$0 { selectedGuest = nil } }),
                            titleVisibility: .visible, presenting: selectedGuest) { guest in
            Button(tr("party.kick"), role: .destructive) { Task { await service.kick(guest.userId) } }
            Button(tr("common.cancel"), role: .cancel) {}
        }
    }

    private func pending() -> [PartyGuest] {
        guard let party = service.party else { return [] }
        return PartyPeople.pending(host: party.host, guests: party.guests ?? [], members: service.members)
    }

    private var actions: some View {
        let ready = service.me?.status == "ready"
        return VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 24) {
                if service.isHost {
                    Button { Task { await service.start() } } label: {
                        Label(tr("party.start"), systemImage: "play.fill")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!service.canStart)
                }
                Button { Task { await service.setReady(!ready) } } label: {
                    Label(ready ? tr("party.not_ready") : tr("party.ready"),
                          systemImage: ready ? "checkmark.circle.fill" : "circle")
                }
                .buttonStyle(.bordered)
                if service.chatEnabled {
                    Button { service.sheet = .chat } label: {
                        Label(tr("party.tv_chat"), systemImage: "bubble.left")
                    }
                    .buttonStyle(.bordered)
                }
                Button { service.sheet = .settings } label: {
                    Label(tr("party.settings"), systemImage: "gearshape")
                }
                .buttonStyle(.bordered)
                Spacer(minLength: 80)
                // The host does not leave a party: ending or cancelling it is the way out.
                if service.isHost {
                    EndPartyButton()
                } else {
                    Button { Task { await service.leaveToHome() } } label: {
                        Label(tr("party.tv_leave"), systemImage: "rectangle.portrait.and.arrow.right")
                    }
                    .buttonStyle(DestructiveButtonStyle())
                }
            }
            if !service.isHost {
                Text(tr("party.tv_wait_host")).font(.callout).foregroundStyle(.secondary)
            } else if service.party?.item == nil, !service.proposals.isEmpty {
                Text(tr(service.voteTied ? "party.start_tie" : "party.start_top_vote")).font(.callout).foregroundStyle(.secondary)
            }
        }
        .focusSection()
    }

    private var members: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(tr("party.tab_members")).font(.headline).foregroundStyle(.secondary)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 36) {
                    ForEach(service.members) { member in
                        AvatarTile(name: member.username,
                                   caption: member.isHost ? tr("party.host_badge") : tr("party.status_\(member.status)"),
                                   badge: PartyBadge.status(member.status), dimmed: member.status == "away",
                                   action: service.isHost && !member.isHost ? { selected = member } : nil)
                    }
                    ForEach(pending(), id: \.userId) { guest in
                        AvatarTile(name: guest.username,
                                   caption: tr(guest.source == "link" ? "party.person_link" : "party.person_absent"),
                                   badge: PartyBadge.Badge(symbol: "envelope.fill", color: .gray), dimmed: true,
                                   action: service.isHost ? { selectedGuest = guest } : nil)
                    }
                    if service.isHost {
                        AvatarTile(name: tr("party.programme_add"), symbol: "plus") { service.sheet = .invite }
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 24)
            }
            .scrollClipDisabled()
        }
        .focusSection()
    }
}

private extension PartyLobbyView {
    var proposals: some View {
        let rows = PartyProposal.sorted(service.openProposals)
        let myId = AuthService.shared.currentUser?.id
        return VStack(alignment: .leading, spacing: 10) {
            Text(tr("party.proposals")).font(.headline).foregroundStyle(.secondary)
            Button { service.sheet = .propose } label: { Label(tr("party.propose"), systemImage: "plus") }
                .buttonStyle(.bordered)
            if rows.isEmpty {
                Text(tr("party.tv_proposals_empty")).font(.callout).foregroundStyle(.secondary)
            } else {
                Rail(title: nil, items: rows) { proposal in
                    ProposalCard(proposal: proposal, myId: myId)
                }
            }
        }
    }
}

/// Chat bubbles of the party over the video: not focusable, they fade after a few seconds.
struct PartyBubbles: View {
    @Environment(PartyService.self) private var service

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(service.bubbles) { message in
                Text(message.chatLine)
                    .font(.callout)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .background(.black.opacity(0.65), in: RoundedRectangle(cornerRadius: 10))
            }
        }
        .animation(.easeOut(duration: 0.2), value: service.bubbles)
        .allowsHitTesting(false)
    }
}

/// A proposal: the poster, then the vote buttons (and the host's pick) below it, outside the card.
private struct ProposalCard: View {
    @Environment(PartyService.self) private var service
    let proposal: PartyProposal
    let myId: Int?
    @State private var confirmRemove = false

    var body: some View {
        let up = myId.map(proposal.upvoterIds.contains) ?? false
        let down = myId.map(proposal.downvoterIds.contains) ?? false
        VStack(spacing: 12) {
            PosterCard(imagePath: proposal.item.hidden ? nil : proposal.item.posterUrl, title: proposal.item.shownTitle) {}
            HStack(spacing: 12) {
                voteButton(tr("party.vote_up"), symbol: up ? "hand.thumbsup.fill" : "hand.thumbsup",
                           count: proposal.upvoterIds.count) { Task { await service.vote(proposal.id, up ? nil : 1) } }
                voteButton(tr("party.vote_down"), symbol: down ? "hand.thumbsdown.fill" : "hand.thumbsdown",
                           count: proposal.downvoterIds.count) { Task { await service.vote(proposal.id, down ? nil : -1) } }
                if service.isHost || proposal.proposedBy == myId {
                    Button { confirmRemove = true } label: { Image(systemName: "trash") }
                        .buttonStyle(.bordered)
                        .accessibilityLabel(tr("party.proposal_remove"))
                        .confirmationDialog(tr("party.proposal_remove"), isPresented: $confirmRemove, titleVisibility: .visible) {
                            Button(tr("party.proposal_remove"), role: .destructive) { Task { await service.removeProposal(proposal.id) } }
                            Button(tr("common.cancel"), role: .cancel) {}
                        } message: { Text(trp("party.proposal_remove_message", ["title": proposal.item.itemName])) }
                }
            }
            if service.isHost {
                Button(tr("party.choose")) { Task { await service.choose(proposal.id) } }
                    .buttonStyle(.borderedProminent)
                    .disabled(proposal.item.hidden)
            }
        }
        .frame(width: 280)
    }

    private func voteButton(_ label: String, symbol: String, count: Int, action: @escaping () -> Void) -> some View {
        Button(action: action) { Label("\(count)", systemImage: symbol) }
            .buttonStyle(.bordered)
            .accessibilityLabel(label)
    }
}
