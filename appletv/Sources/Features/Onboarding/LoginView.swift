import SwiftUI

/// Password fallback. De-emphasized on purpose — quick connect is the
/// recommended path on a TV with no physical keyboard. Username arrives
/// prefilled+locked when coming from the user picker.
struct LoginView: View {
    let prefilledUsername: String?

    @Environment(AuthService.self) private var auth
    @State private var username: String
    @State private var password = ""
    @State private var loading = false
    @State private var error: String?

    init(prefilledUsername: String?) {
        self.prefilledUsername = prefilledUsername
        _username = State(initialValue: prefilledUsername ?? "")
    }

    private var usernameLocked: Bool { prefilledUsername != nil }

    var body: some View {
        VStack(spacing: 20) {
            Text(tr("login.title"))
                .font(.title2)
                .foregroundStyle(.secondary)

            if usernameLocked {
                Text(username).font(.title3.weight(.semibold))
            } else {
                TextField(tr("login.username"), text: $username)
                    .autocorrectionDisabled()
            }

            SecureField(tr("login.password"), text: $password)
                .onSubmit { Task { await submit() } }

            if let error {
                Text(error).foregroundStyle(.red)
            }

            if loading {
                ProgressView()
            } else {
                Button(tr("login.submit")) { Task { await submit() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(username.isEmpty || password.isEmpty)
            }
        }
        .padding(60)
        .frame(maxWidth: 600)
    }

    private func submit() async {
        loading = true
        error = nil
        do {
            try await auth.login(username: username, password: password)
        } catch {
            self.error = tr("login.error")
        }
        loading = false
    }
}
