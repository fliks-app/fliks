import SwiftUI

/// Day, hour and minute menus: tvOS has no date picker. Quarter hours, from now to two months ahead.
struct PartySchedulePicker: View {
    @Binding var date: Date

    private static let cal = Calendar.current
    private static func days() -> [Date] {
        (0..<60).compactMap { cal.date(byAdding: .day, value: $0, to: cal.startOfDay(for: Date())) }
    }

    private static func dayLabel(_ day: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: LocaleStore.shared.lang)
        f.setLocalizedDateFormatFromTemplate("EEEdMMM")
        return f.string(from: day)
    }

    var body: some View {
        let c = Self.cal
        let day = Binding(get: { c.startOfDay(for: date) }, set: { new in
            date = c.date(bySettingHour: c.component(.hour, from: date), minute: c.component(.minute, from: date), second: 0, of: new) ?? date
        })
        let hour = Binding(get: { c.component(.hour, from: date) }, set: { date = c.date(bySettingHour: $0, minute: c.component(.minute, from: date), second: 0, of: date) ?? date })
        let minute = Binding(get: { c.component(.minute, from: date) / 15 * 15 }, set: { date = c.date(bySettingHour: c.component(.hour, from: date), minute: $0, second: 0, of: date) ?? date })
        HStack(spacing: 20) {
            Picker("", selection: day) {
                ForEach(Self.days(), id: \.self) { Text(Self.dayLabel($0)).tag($0) }
            }
            Picker("", selection: hour) { ForEach(0..<24, id: \.self) { Text(String(format: "%02d", $0)).tag($0) } }
            Text(":")
            Picker("", selection: minute) { ForEach([0, 15, 30, 45], id: \.self) { Text(String(format: "%02d", $0)).tag($0) } }
        }
    }

    /// The next full hour: a sensible default for a party planned for later.
    static var nextHour: Date {
        let c = Calendar.current
        return c.date(bySetting: .minute, value: 0, of: Date().addingTimeInterval(3600)) ?? Date().addingTimeInterval(3600)
    }
}

/// "Watch together": the film (or "pick later"), name, now or scheduled, who to invite and the party switches.
struct PartyCreateView: View {
    @Environment(PartyService.self) private var service
    @State private var target = PartyCreateTarget()
    @State private var film: PartyPick?
    @State private var name = ""
    @State private var later = false
    @State private var when = PartySchedulePicker.nextHour
    @State private var following: [SocialUser] = []
    @State private var picked: [Int] = []
    @State private var everyone = true
    @State private var reactions = true
    @State private var chat = true
    @State private var link = true
    @State private var busy = false
    @State private var picking = false
    @State private var loaded = false

    private var fromPlaylist: Bool { target.playlistId != nil }
    private var canSubmit: Bool { !busy && !name.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        Group {
            if picking {
                PartyMediaPicker(onPick: { picks in
                    if let pick = picks.first {
                        if name.isEmpty || name == film?.title || name == tr("party.watch_together") { name = pick.title }
                        film = pick
                    }
                    picking = false
                }, onCancel: { picking = false })
            } else {
                form
            }
        }
        .task {
            guard !loaded else { return }
            loaded = true
            target = service.createTarget
            name = target.name.isEmpty ? tr("party.watch_together") : target.name
            if let me = AuthService.shared.currentUser?.id,
               let list: [SocialUser] = try? await APIClient.shared.get("/api/social/users/\(me)/following") { following = list }
        }
    }

    private var form: some View {
        PartySheetPage(title: tr("party.create_title")) {
            ScrollView {
                VStack(alignment: .leading, spacing: 32) {
                    filmRow
                    TextField(tr("party.create_name"), text: $name)
                    VStack(alignment: .leading, spacing: 12) {
                        Picker(tr("party.create_when"), selection: $later) {
                            Text(tr("party.create_now")).tag(false)
                            Text(tr("party.create_later")).tag(true)
                        }
                        .pickerStyle(.segmented)
                        if later { PartySchedulePicker(date: $when) }
                    }
                    invitees
                    Toggle(tr("party.switch_playback_control"), isOn: $everyone)
                    Toggle(tr("party.switch_reactions"), isOn: $reactions)
                    Toggle(tr("party.switch_chat"), isOn: $chat)
                    Toggle(tr("party.switch_link_sharing"), isOn: $link)
                }
                .frame(maxWidth: 1100)
                .padding(30)
                .frame(maxWidth: .infinity)
            }
        } bar: {
            HStack(spacing: 30) {
                Button(action: submit) {
                    Text(tr(later ? "party.create_schedule" : "party.create_start"))
                }
                .buttonStyle(.borderedProminent)
                .disabled(!canSubmit)
                Button(tr("common.cancel")) { service.sheet = nil }
                    .buttonStyle(.bordered)
            }
            .focusSection()
        }
    }

    @ViewBuilder
    private var filmRow: some View {
        if fromPlaylist {
            Text(trp("party.playlist_label", ["name": target.name])).foregroundStyle(.secondary)
        } else {
            HStack(spacing: 24) {
                Text(film?.title ?? (target.mediaId != nil ? target.name : tr("party.create_programme_later")))
                    .foregroundStyle(.secondary).lineLimit(1)
                Spacer()
                Button(tr("party.programme_add")) { picking = true }.buttonStyle(.bordered)
                if film != nil || target.mediaId != nil {
                    Button(tr("party.programme_remove")) { film = nil; target.mediaId = nil; target.mediaFileId = nil; target.episodeId = nil }
                        .buttonStyle(.bordered)
                }
            }
        }
    }

    @ViewBuilder
    private var invitees: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(tr("party.create_invitees")).font(.headline).foregroundStyle(.secondary)
            if following.isEmpty {
                Text(tr("party.no_followed")).font(.callout).foregroundStyle(.secondary)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(alignment: .top, spacing: 36) {
                        ForEach(following) { user in
                            AvatarTile(name: user.username, selected: picked.contains(user.id)) {
                                if let at = picked.firstIndex(of: user.id) { picked.remove(at: at) } else { picked.append(user.id) }
                            }
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.vertical, 24)
                }
                .scrollClipDisabled()
            }
        }
        .focusSection()
    }

    private func submit() {
        busy = true
        var request = PartyCreateRequest(name: name.trimmingCharacters(in: .whitespaces))
        if let playlistId = target.playlistId {
            request.playlistId = playlistId
        } else if let film {
            request.mediaId = film.mediaId
            request.episodeId = film.episodeId
        } else {
            request.mediaId = target.mediaId
            request.mediaFileId = target.mediaFileId
            request.episodeId = target.episodeId
        }
        if later { request.scheduledAt = PartyCreateRequest.iso(when) }
        request.policy = everyone ? "everyone" : "host_only"
        request.reactionsEnabled = reactions
        request.chatEnabled = chat
        request.linkSharing = link
        request.inviteeIds = picked
        Task {
            await service.create(request)
            busy = false
        }
    }
}
