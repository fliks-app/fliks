import SwiftUI

/// A scheduled party's lobby, open from its creation: header, actions, who is here, the programme and the proposals.
struct PartyLobbyView: View {
    @Environment(PartyService.self) private var service
    @Environment(Backdrop.self) private var backdrop
    @Environment(\.dismiss) private var dismiss
    @State private var visible = false
    @State private var selected: PartyMember?
    @State private var selectedGuest: PartyGuest?
    @State private var confirmLeave = false

    var body: some View {
        ScrollView {
            if let party = service.party {
                VStack(alignment: .leading, spacing: 44) {
                    PartyHeaderView(party: party)
                    actions
                    members
                    programme
                    proposals
                }
                .padding(.horizontal, 60)
                .padding(.vertical, 48)
            }
        }
        .overlay(alignment: .bottom) { PartyNotice() }
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
        .confirmationDialog(tr("party.tv_leave"), isPresented: $confirmLeave, titleVisibility: .visible) {
            Button(tr("party.tv_leave_host_confirm"), role: .destructive) { Task { await service.endParty() } }
            Button(tr("common.cancel"), role: .cancel) {}
        } message: { Text(trp("party.tv_leave_host_message", ["name": service.party?.name ?? ""])) }
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
                Button { if service.isHost { confirmLeave = true } else { Task { await service.leaveToHome() } } } label: {
                    Label(tr("party.tv_leave"), systemImage: "rectangle.portrait.and.arrow.right")
                }
                .buttonStyle(DestructiveButtonStyle())
            }
            if !service.isHost {
                Text(tr("party.tv_wait_host")).font(.callout).foregroundStyle(.secondary)
            } else if service.party?.item == nil, !service.proposals.isEmpty {
                Text(tr("party.start_top_vote")).font(.callout).foregroundStyle(.secondary)
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
                                   caption: tr(guest.source == "link" ? "party.person_link" : "party.person_invited"),
                                   badge: PartyBadge.Badge(symbol: "envelope.fill", color: .gray), dimmed: true,
                                   action: service.isHost ? { selectedGuest = guest } : nil)
                    }
                    if service.isHost {
                        AvatarTile(name: tr("party.invite"), symbol: "plus") { service.sheet = .invite }
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
    struct ProgrammeRow: Identifiable {
        let id: Int
        let item: PartyItem
    }

    var programme: some View {
        let rows = service.queue.enumerated().map { ProgrammeRow(id: $0.offset, item: $0.element) }
        return section(tr("party.programme"), empty: tr("party.programme_empty"), isEmpty: rows.isEmpty) {
            Rail(title: nil, items: rows) { row in
                PosterCard(imagePath: row.item.hidden ? nil : row.item.posterUrl, title: row.item.shownTitle,
                           caption: String(row.id + 1)) {}
            }
        }
    }

    var proposals: some View {
        let rows = PartyProposal.sorted(service.proposals)
        return section(tr("party.proposals"), empty: tr("party.tv_proposals_empty"), isEmpty: rows.isEmpty) {
            Rail(title: nil, items: rows) { proposal in
                let count = proposal.voterIds.count
                PosterCard(imagePath: proposal.item.hidden ? nil : proposal.item.posterUrl, title: proposal.item.shownTitle,
                           caption: trp(count == 1 ? "party.tv_votes_one" : "party.tv_votes_other", ["count": String(count)])) {}
            }
        }
    }

    /// Read-only: the cards only let the remote scroll the page down to them.
    func section<Content: View>(_ title: String, empty: String, isEmpty: Bool,
                                @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.headline).foregroundStyle(.secondary)
            if isEmpty { Text(empty).font(.callout).foregroundStyle(.secondary) } else { content() }
        }
    }
}

/// Chat bubbles of the party over the video: not focusable, they fade after a few seconds.
struct PartyBubbles: View {
    @Environment(PartyService.self) private var service

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(service.bubbles) { message in
                Text("\(message.username ?? "")\(tr("party.chat_name_sep"))\(message.text)")
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
