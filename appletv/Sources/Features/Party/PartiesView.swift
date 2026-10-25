import SwiftUI

/// Live and scheduled parties of the user, plus joining with an invite code or link.
struct PartiesView: View {
    @Environment(PartyService.self) private var service
    @State private var parties: [Party] = []
    @State private var code = ""
    @State private var loaded = false

    var body: some View {
        List {
            Section(tr("party.tv_join_code")) {
                TextField(tr("party.tv_code_placeholder"), text: $code)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .onSubmit(joinWithCode)
                Button(tr("party.join"), action: joinWithCode)
                    .disabled(code.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            Section(tr("party.rail_title")) {
                if parties.isEmpty, loaded {
                    Text(tr("party.tv_no_parties")).foregroundStyle(.secondary)
                }
                ForEach(parties) { party in
                    Button { Task { await service.enter(id: party.id) } } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(party.name).font(.headline)
                            Text(party.item.title).font(.callout).foregroundStyle(.secondary)
                            Text(detail(party)).font(.caption).foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
        .task {
            while !Task.isCancelled {
                if let list: [Party] = try? await APIClient.shared.get("/api/parties") { parties = list }
                loaded = true
                try? await Task.sleep(for: .seconds(10))
            }
        }
        .overlay(alignment: .bottom) { PartyNotice() }
    }

    private func joinWithCode() {
        let value = code
        Task { await service.join(code: value) }
    }

    private func detail(_ party: Party) -> String {
        if party.status == "live" {
            let key = party.memberCount == 1 ? "party.card_live_one" : "party.card_live_other"
            return trp(key, ["host": party.host.username, "count": String(party.memberCount)])
        }
        let when = party.scheduledAt.map { $0.formatted(date: .abbreviated, time: .shortened) } ?? ""
        return trp("party.card_scheduled", ["when": when, "host": party.host.username])
    }
}

/// The transient line of `PartyService` (errors, refusals), over whatever screen shows it.
struct PartyNotice: View {
    @Environment(PartyService.self) private var service

    var body: some View {
        if let notice = service.notice {
            Text(notice)
                .font(.callout)
                .padding(14)
                .background(.black.opacity(0.7), in: RoundedRectangle(cornerRadius: 10))
                .padding(.bottom, 50)
                .transition(.opacity)
        }
    }
}
