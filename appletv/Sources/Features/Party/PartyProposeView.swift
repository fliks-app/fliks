import SwiftUI

/// Suggest a film (or an episode) for the start.
struct PartyProposeView: View {
    @Environment(PartyService.self) private var service

    var body: some View {
        PartyMediaPicker(onPick: { picks in
            guard let pick = picks.first else { return }
            Task { if await service.propose(mediaId: pick.mediaId, episodeId: pick.episodeId) { service.sheet = nil } }
        }, onCancel: { service.sheet = nil })
    }
}
