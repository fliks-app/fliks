import Foundation

/// What a title's Play button starts: the client's `nextUp()` on tvOS.
struct PlayTarget: Hashable {
    let mediaFileId: Int
    let episodeId: Int?
    let resume: Bool
    /// "S02E07" for an episode.
    var code: String?

    /// Movie: its file. Series: the resume episode, else the first unwatched episode with a file,
    /// else the first with a file; specials are skipped.
    static func of(_ media: Media, resume: MediaResumeInfo?, watchedEpisodes: Set<Int>) -> PlayTarget? {
        guard media.type.isPlayable else { return nil }
        if !media.type.hasChildren {
            guard let fileId = resume?.mediaFileId ?? media.files?.first(where: { $0.episodeId == nil })?.id else {
                return nil
            }
            return PlayTarget(mediaFileId: fileId, episodeId: nil, resume: (resume?.positionSeconds ?? 0) > 0)
        }
        let seasons = (media.seasons ?? []).filter { $0.seasonNumber > 0 }.sorted { $0.seasonNumber < $1.seasonNumber }
        let fileOf = { (epId: Int) in media.files?.first(where: { $0.episodeId == epId })?.id }
        if let resume, let episodeId = resume.episodeId {
            for s in seasons {
                if let ep = s.episodes.first(where: { $0.id == episodeId }) {
                    return PlayTarget(mediaFileId: resume.mediaFileId, episodeId: ep.id, resume: resume.positionSeconds > 0,
                                      code: code(s, ep))
                }
            }
        }
        for skipWatched in [true, false] {
            for s in seasons {
                for ep in s.episodes.sorted(by: { $0.episodeNumber < $1.episodeNumber })
                where ep.hasFile && !(skipWatched && watchedEpisodes.contains(ep.id)) {
                    if let file = fileOf(ep.id) {
                        return PlayTarget(mediaFileId: file, episodeId: ep.id, resume: false, code: code(s, ep))
                    }
                }
            }
        }
        return nil
    }

    private static func code(_ s: Season, _ ep: Episode) -> String {
        String(format: "S%02dE%02d", s.seasonNumber, ep.episodeNumber)
    }
}
