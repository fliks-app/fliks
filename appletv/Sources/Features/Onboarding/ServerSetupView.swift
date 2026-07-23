import SwiftUI

/// First-run / "change server" screen. Test hits the candidate URL directly
/// (not yet saved, so not through `APIClient`/`ServerStore`) — a 401 means the
/// server is reachable but not authenticated, which is the expected state.
struct ServerSetupView: View {
    @Environment(ServerStore.self) private var server
    @Environment(AuthService.self) private var auth

    @State private var url: String
    @State private var testing = false
    @State private var testOk: Bool?

    init() {
        let current = ServerStore.shared.url
        _url = State(initialValue: current.isEmpty ? "http://" : current)
    }

    var body: some View {
        VStack(spacing: 28) {
            Text(tr("setup.title")).font(.system(size: 44, weight: .bold))

            TextField(tr("setup.url_placeholder"), text: $url)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .frame(maxWidth: 700)
                .onSubmit { Task { await test() } }
                .onChange(of: url) { _, _ in testOk = nil }

            HStack(spacing: 20) {
                Button(tr("setup.test")) { Task { await test() } }
                    .disabled(testing)
                if testOk == true {
                    Button(tr("setup.save")) { save() }
                        .buttonStyle(.borderedProminent)
                }
            }

            if testing {
                ProgressView()
            } else if let testOk {
                Text(testOk ? tr("setup.test_success") : tr("setup.test_error"))
                    .foregroundStyle(testOk ? .green : .red)
            }

            if !server.knownServers.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    Text(tr("setup.known_servers"))
                        .font(.headline)
                        .foregroundStyle(.secondary)
                    ForEach(server.knownServers) { known in
                        Button {
                            useKnown(known)
                        } label: {
                            HStack {
                                Text(known.name ?? known.url)
                                Spacer()
                                if let user = known.lastUsername {
                                    Text(user).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
                .frame(maxWidth: 700)
            }
        }
        .padding(60)
    }

    private func test() async {
        let trimmed = trimSlashes(url)
        guard let u = URL(string: trimmed + "/api/auth/me") else {
            testOk = false
            return
        }
        testing = true
        testOk = nil
        do {
            let (_, response) = try await URLSession.shared.data(from: u)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            testOk = status == 401 || (200..<300).contains(status)
        } catch {
            testOk = false
        }
        testing = false
    }

    private func save() {
        server.save(trimSlashes(url))
        auth.resetForServerSwitch()
    }

    /// One-tap "use this server" — already known, skip the test step.
    private func useKnown(_ known: KnownServer) {
        server.save(known.url)
        auth.resetForServerSwitch()
    }

    private func trimSlashes(_ s: String) -> String {
        var s = s.trimmingCharacters(in: .whitespaces)
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }
}
