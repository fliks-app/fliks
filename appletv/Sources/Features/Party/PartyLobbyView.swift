import SwiftUI

/// A scheduled party whose lobby is open: who is here, ready toggle, and the host's start.
struct PartyLobbyView: View {
    @Environment(PartyService.self) private var service
    @Environment(\.dismiss) private var dismiss
    @State private var visible = false

    var body: some View {
        List {
            if let party = service.party {
                Section {
                    Text(party.name).font(.title2.bold())
                    if party.item.title != party.name { Text(party.item.title).foregroundStyle(.secondary) }
                    Text(trp("party.hosted_by", ["host": party.host.username])).foregroundStyle(.secondary)
                }
                Section(tr("party.tab_members")) {
                    ForEach(service.members) { member in
                        HStack {
                            Text(member.username + (member.isHost ? " · \(tr("party.host_badge"))" : ""))
                            Spacer()
                            Text(tr("party.status_\(member.status)")).foregroundStyle(.secondary)
                        }
                    }
                }
                Section {
                    let ready = service.me?.status == "ready"
                    Button(ready ? tr("party.not_ready") : tr("party.ready")) {
                        Task { await service.setReady(!ready) }
                    }
                    if service.isHost {
                        Button(tr("party.start")) { Task { await service.start() } }
                    } else {
                        Text(tr("party.tv_wait_host")).foregroundStyle(.secondary)
                    }
                    Button(tr("party.invite")) { service.sheet = .invite }
                    Button(tr("party.settings")) { service.sheet = .settings }
                    Button(tr("party.tv_leave"), role: .destructive) { Task { await service.leave() } }
                }
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
        }
        // Going live hands the screen to the player, which owns the party from there.
        .onDisappear {
            visible = false
            if service.lobby { Task { await service.leave() } }
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
