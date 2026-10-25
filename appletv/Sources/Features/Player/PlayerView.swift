import SwiftUI
import UIKit
import Foundation
import AVFoundation
import AVKit

/// Fullscreen tvOS player: a wrapped `AVPlayerViewController` (system scrub bar and pickers),
/// with next-episode surfaced as `contextualActions`.
struct PlayerView: View {
    let mediaFileId: Int
    let mediaId: Int
    let episodeId: Int?
    let startAt: Double
    /// Called when the user dismisses a terminal error card.
    var onExit: () -> Void

    @State private var coordinator = PlayerCoordinator()
    @State private var partyController: PartyController?
    @State private var partyBound = false
    @Environment(PartyService.self) private var party
    @State private var loading = true
    @State private var loadErrorText: String?

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if let player = coordinator.player {
                PlayerContainer(player: player, coordinator: coordinator)
                    .ignoresSafeArea()
            }

            if coordinator.recoveringHint {
                Text(tr("player.reconnecting"))
                    .font(.callout)
                    .padding(12)
                    .background(.black.opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
                    .padding(.top, 60)
                    .frame(maxHeight: .infinity, alignment: .top)
            }

            if coordinator.showSkipCommercial {
                SkipIntroButton(progress: coordinator.skipCommercialProgress,
                                secondsLeft: coordinator.skipCommercialSecondsLeft,
                                label: "player.edl.skip_commercial") { coordinator.skipCommercial() }
                    .id(coordinator.skipCommercialOrdinal)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                    .padding(60)
            } else if coordinator.showSkipIntro {
                SkipIntroButton(progress: coordinator.skipIntroProgress,
                                secondsLeft: coordinator.skipIntroSecondsLeft) { coordinator.skipIntro() }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                    .padding(60)
            }

            if partyController != nil {
                PartyBubbles()
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                    .padding(60)
            }

            if partyController != nil, let notice = party.notice {
                Text(notice)
                    .font(.callout)
                    .padding(12)
                    .background(.black.opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
                    .padding(.top, 60)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            }

            if let notice = coordinator.edlNotice {
                Text(notice)
                    .font(.callout)
                    .padding(12)
                    .background(.black.opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
                    .padding(.top, 60)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                    .padding(.trailing, 60)
            }

            if let text = loadErrorText ?? (coordinator.fatalError ? tr("player.playback_error") : nil) {
                VStack(spacing: 20) {
                    Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 64))
                    Text(text).font(.title2)
                    Button(tr("common.ok"), action: onExit)
                }
                .foregroundStyle(.white)
            } else if loading {
                ProgressView().controlSize(.large).tint(.white)
            }
        }
        .task {
            coordinator.onStopRequested = onExit
            let inParty = party.takeHandoff()
            partyBound = inParty
            do {
                try await coordinator.load(mediaFileId: mediaFileId, mediaId: mediaId, episodeId: episodeId,
                                           startAt: startAt, autoplay: !inParty)
                if inParty {
                    party.onClosed = { _ in onExit() }
                    let controller = PartyController(player: coordinator)
                    partyController = controller
                    controller.attach()
                }
            } catch {
                print("player: load failed: \(error)")
                loadErrorText = tr("player.load_error")
                if inParty { await party.leave() }
            }
            loading = false
        }
        .onDisappear {
            if let partyController { partyController.detach() } else if partyBound { Task { await party.leave() } }
            party.onClosed = nil
            coordinator.teardown()
        }
    }
}

/// Bridges the coordinator's `AVPlayer` into a native `AVPlayerViewController`.
private struct PlayerContainer: UIViewControllerRepresentable {
    let player: AVPlayer
    let coordinator: PlayerCoordinator

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let vc = AVPlayerViewController()
        vc.player = player
        vc.requiresLinearPlayback = false
        coordinator.playerViewController = vc
        coordinator.applyTransportMenus()
        return vc
    }

    func updateUIViewController(_ uiViewController: AVPlayerViewController, context: Context) {
        if uiViewController.player !== player {
            uiViewController.player = player
        }
    }
}

/// Skip-intro badge whose fill empties over the reveal window; custom focus ring, focused on appear.
private struct SkipIntroButton: View {
    let progress: Double      // 0..1 elapsed
    let secondsLeft: Int
    var label = "player.skip_intro"
    var action: () -> Void
    @FocusState private var focused: Bool

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: "forward.end.fill")
                Text("\(tr(label)) (\(secondsLeft))")
            }
            .font(.callout.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 22)
            .padding(.vertical, 12)
            .background(alignment: .leading) {
                GeometryReader { geo in
                    Rectangle()
                        .fill(.white.opacity(0.28))
                        .frame(width: geo.size.width * (1 - min(1, max(0, progress))))
                        .animation(.linear(duration: 1), value: progress)
                }
            }
            .background(.white.opacity(0.14))
            .clipShape(Capsule())
            .overlay(Capsule().strokeBorder(.white, lineWidth: focused ? 4 : 0))
        }
        .buttonStyle(SkipCueStyle())
        .scaleEffect(focused ? 1.06 : 1)
        .focused($focused)
        .onAppear { focused = true }
        .animation(.easeOut(duration: 0.15), value: focused)
    }
}

private struct SkipCueStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.85 : 1)
    }
}
