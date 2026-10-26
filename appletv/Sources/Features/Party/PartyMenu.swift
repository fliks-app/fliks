import UIKit

/// The party's entry in the player's transport bar: members, chat phrases, queue, host settings.
@MainActor
enum PartyMenu {
    static func key(_ p: PartyService) -> String {
        let members = p.members.map { "\($0.id):\($0.status):\($0.role)" }.joined(separator: ",")
        let queue = p.queue.map { "\($0.mediaId).\($0.episodeId ?? 0)" }.joined(separator: ",")
        let pend = pending(p).map { "\($0.userId)" }.joined(separator: ",")
        let cur = p.item.map { "\($0.mediaId).\($0.episodeId ?? 0)" } ?? ""
        return [members, pend, p.policy, String(p.chatEnabled), String(p.reactionsEnabled), p.reactionBar.joined(), String(p.isHost), queue, cur].joined(separator: "|")
    }

    static func build(_ p: PartyService, onResync: @escaping () -> Void, onLeave: @escaping () -> Void) -> UIMenu {
        // The host ends the party (it asks first) instead of leaving; a member just leaves.
        var children: [UIMenuElement] = [membersMenu(p)]
        if p.chatEnabled { children.append(chatMenu(p)) }
        if p.reactionsEnabled { children.append(reactionsMenu(p)) }
        if p.canControl, !p.queue.isEmpty { children.append(queueMenu(p)) }
        children.append(UIAction(title: tr("party.resync"), image: UIImage(systemName: "arrow.triangle.2.circlepath")) { _ in onResync() })
        children.append(UIAction(title: tr("party.settings"), image: UIImage(systemName: "gearshape")) { _ in p.sheet = .settings })
        children.append(UIMenu(options: .displayInline, children: [
            p.isHost
                ? UIAction(title: tr(p.party?.status == "live" ? "party.end" : "party.cancel"), image: UIImage(systemName: "xmark.circle"),
                           attributes: .destructive) { _ in p.leaveConfirm = true }
                : UIAction(title: tr("party.tv_leave"), image: UIImage(systemName: "rectangle.portrait.and.arrow.right"),
                           attributes: .destructive) { _ in onLeave() },
        ]))
        return UIMenu(title: tr("party.panel_toggle"), image: UIImage(systemName: "person.2.fill"), children: children)
    }

    private static func pending(_ p: PartyService) -> [PartyGuest] {
        guard let party = p.party else { return [] }
        return PartyPeople.pending(host: party.host, guests: party.guests ?? [], members: p.members)
    }

    private static func membersMenu(_ p: PartyService) -> UIMenu {
        let myId = AuthService.shared.currentUser?.id
        let rows = p.members.map { m -> UIMenuElement in
            let label = "\(m.username) · \(tr("party.status_\(m.status)"))" + (m.isHost ? " · \(tr("party.host_badge"))" : "")
            guard p.isHost, m.userId != myId else { return UIAction(title: label, attributes: .disabled) { _ in } }
            return UIMenu(title: label, children: [
                UIAction(title: tr("party.make_host")) { _ in Task { await p.makeHost(m.userId) } },
                UIAction(title: tr("party.kick"), attributes: .destructive) { _ in Task { await p.kick(m.userId) } },
            ])
        }
        var all = rows + pending(p).map { guest -> UIMenuElement in
            let label = "\(guest.username) · \(tr(guest.source == "link" ? "party.person_link" : "party.person_invited"))"
            guard p.isHost else { return UIAction(title: label, attributes: .disabled) { _ in } }
            return UIMenu(title: label, children: [
                UIAction(title: tr("party.kick"), attributes: .destructive) { _ in Task { await p.kick(guest.userId) } },
            ])
        }
        if p.isHost {
            all.append(UIAction(title: tr("party.invite"), image: UIImage(systemName: "person.badge.plus")) { _ in p.sheet = .invite })
        }
        return UIMenu(title: "\(tr("party.tab_members")) (\(p.members.count))", image: UIImage(systemName: "person.3"), children: all)
    }

    private static func chatMenu(_ p: PartyService) -> UIMenu {
        let phrases = ["party.tv_phrase_pause", "party.tv_phrase_5min", "party.tv_phrase_wait"].map { key in
            UIAction(title: tr(key)) { _ in Task { await p.sendMessage(tr(key)) } }
        }
        let open = UIAction(title: tr("party.tv_chat_history"), image: UIImage(systemName: "text.bubble")) { _ in p.sheet = .chat }
        return UIMenu(title: tr("party.tv_chat"), image: UIImage(systemName: "bubble.left"),
                      children: [open, UIMenu(options: .displayInline, children: phrases)])
    }

    private static func reactionsMenu(_ p: PartyService) -> UIMenu {
        let bar = p.reactionBar.map { emoji in UIAction(title: emoji) { _ in Task { await p.react(emoji) } } }
        return UIMenu(title: tr("party.reaction_settings"), image: UIImage(systemName: "face.smiling"), children: bar)
    }

    private static func queueMenu(_ p: PartyService) -> UIMenu {
        let cur = p.item
        let steps = [
            UIAction(title: tr("player.prev_episode"), image: UIImage(systemName: "backward.end")) { _ in Task { await p.sendIntent("previous") } },
            UIAction(title: tr("player.play_next"), image: UIImage(systemName: "forward.end")) { _ in Task { await p.sendIntent("next") } },
        ]
        let items = p.queue.map { item -> UIAction in
            let isCurrent = item.mediaId == cur?.mediaId && item.episodeId == cur?.episodeId
            return UIAction(title: item.shownTitle, state: isCurrent ? .on : .off) { _ in
                if !isCurrent { Task { await p.sendIntent("setItem", item: item) } }
            }
        }
        var edit: [UIMenuElement] = []
        if p.isHost {
            edit.append(UIAction(title: tr("party.programme"), image: UIImage(systemName: "list.number")) { _ in p.sheet = .programme })
        }
        return UIMenu(title: tr("party.tv_queue"), image: UIImage(systemName: "list.bullet"), children: [
            UIMenu(options: .displayInline, children: edit),
            UIMenu(options: .displayInline, children: steps),
            UIMenu(options: .displayInline, children: items),
        ])
    }
}
