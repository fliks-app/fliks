import SwiftUI

/// A scheduled party whose lobby is open: header, actions, then who is here.
struct PartyLobbyView: View {
    @Environment(PartyService.self) private var service
    @Environment(Backdrop.self) private var backdrop
    @Environment(\.dismiss) private var dismiss
    @State private var visible = false
    @State private var selected: PartyMember?

    var body: some View {
        ScrollView {
            if let party = service.party {
                VStack(alignment: .leading, spacing: 44) {
                    header(party)
                    actions
                    members
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
            backdrop.url = service.party?.item.fanartUrl ?? service.party?.item.posterUrl
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
    }

    private func header(_ party: Party) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(party.name).font(.system(size: 48, weight: .bold))
            if party.item.title != party.name { Text(party.item.title).font(.title3) }
            HStack(spacing: 16) {
                Text(trp("party.hosted_by", ["host": party.host.username]))
                Text(party.scheduledAt.map { $0.formatted(date: .abbreviated, time: .shortened) } ?? tr("party.status_lobby"))
            }
            .font(.callout)
            .foregroundStyle(.secondary)
        }
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
                }
                Button { Task { await service.setReady(!ready) } } label: {
                    Label(ready ? tr("party.not_ready") : tr("party.ready"),
                          systemImage: ready ? "checkmark.circle.fill" : "circle")
                }
                .buttonStyle(.bordered)
                Button { service.sheet = .invite } label: {
                    Label(tr("party.invite"), systemImage: "person.badge.plus")
                }
                .buttonStyle(.bordered)
                Button { service.sheet = .settings } label: {
                    Label(tr("party.settings"), systemImage: "gearshape")
                }
                .buttonStyle(.bordered)
                Spacer(minLength: 80)
                Button(role: .destructive) { Task { await service.leave() } } label: {
                    Label(tr("party.tv_leave"), systemImage: "rectangle.portrait.and.arrow.right")
                }
                .buttonStyle(.bordered)
            }
            if !service.isHost {
                Text(tr("party.tv_wait_host")).font(.callout).foregroundStyle(.secondary)
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
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 24)
            }
            .scrollClipDisabled()
        }
        .focusSection()
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
