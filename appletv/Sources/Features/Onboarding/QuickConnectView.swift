import SwiftUI
import UIKit
import CoreImage
import CoreImage.CIFilterBuiltins

/// Quick-connect (code-less) pairing. No numeric code by design — approval
/// happens on the user's phone, on the pending-requests screen. Polls every
/// 2s until the server flips the pairing to approved/denied/expired.
struct QuickConnectView: View {
    let userId: Int
    let username: String

    @Environment(AuthService.self) private var auth
    @Environment(ServerStore.self) private var server

    private enum ViewState: Equatable { case starting, waiting, denied, expired, error }

    @State private var viewState: ViewState = .starting
    @State private var pairingId: String?
    @State private var secondsLeft = 0
    @State private var pollTask: Task<Void, Never>?

    var body: some View {
        VStack(spacing: 28) {
            switch viewState {
            case .starting:
                ProgressView()

            case .waiting:
                Text(tr("quick_connect.title")).font(.system(size: 44, weight: .bold))
                Text(tr("quick_connect.instructions", username))
                    .font(.title3)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: 700)
                if let qr = qrImage("\(server.url)/pending-requests") {
                    qr.interpolation(.none)
                        .resizable()
                        .frame(width: 220, height: 220)
                        .padding(16)
                        .background(Color.white)
                        .clipShape(RoundedRectangle(cornerRadius: 16))
                }
                Text(tr("quick_connect.expires_in", minutesLeft))
                    .foregroundStyle(.secondary)
                ProgressView().padding(.top, 8)

            case .denied:
                Text(tr("quick_connect.denied")).font(.title2)
                Button(tr("common.retry")) { Task { await start() } }
                    .buttonStyle(.borderedProminent)

            case .expired:
                Text(tr("quick_connect.expired")).font(.title2)
                Button(tr("common.retry")) { Task { await start() } }
                    .buttonStyle(.borderedProminent)

            case .error:
                Text(tr("error.network")).font(.title2)
                Button(tr("common.retry")) { Task { await start() } }
                    .buttonStyle(.borderedProminent)
            }
        }
        .padding(60)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task { await start() }
        .onDisappear { pollTask?.cancel() }
    }

    private var minutesLeft: Int { max(0, Int(ceil(Double(secondsLeft) / 60))) }

    private func start() async {
        // A transient re-mount during the sign-in transition must not fire a
        // second pairing request — only request while still signed out.
        guard auth.state == .signedOut else { return }
        pollTask?.cancel()
        viewState = .starting
        do {
            let res = try await auth.requestPairing(
                userId: userId,
                deviceName: UIDevice.current.name,
                systemName: "tvOS \(UIDevice.current.systemVersion)"
            )
            pairingId = res.pairingId
            secondsLeft = res.expiresIn
            viewState = .waiting
            pollTask = Task { await poll() }
        } catch {
            viewState = .error
        }
    }

    private func poll() async {
        guard let pairingId else { return }
        while !Task.isCancelled, secondsLeft > 0 {
            do {
                let res = try await auth.pairingStatus(pairingId: pairingId)
                switch res.status {
                case "approved":
                    if let token = res.accessToken {
                        try await auth.loginWithToken(access: token, refresh: res.refreshToken)
                        return
                    }
                case "denied":
                    viewState = .denied
                    return
                case "expired":
                    viewState = .expired
                    return
                default:
                    break
                }
            } catch {
                // Network blip — keep polling, the server is the source of truth.
            }
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            secondsLeft -= 2
        }
        if !Task.isCancelled, viewState == .waiting {
            viewState = .expired
        }
    }

    private func qrImage(_ string: String) -> Image? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        let context = CIContext()
        guard let output = filter.outputImage,
              let cg = context.createCGImage(output, from: output.extent) else { return nil }
        return Image(decorative: cg, scale: 1)
    }
}
