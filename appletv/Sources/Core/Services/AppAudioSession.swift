import AVFoundation
import os

/// The one owner of the app's audio session: `.playback` while a video or the music player holds it, the
/// mixable `.ambient` one of the focus click once nobody does, so one releasing never cuts the other.
/// A holder is released by the owner that acquired it: a replaced player's late release cannot cut its successor's.
@MainActor
enum AppAudioSession {
    enum Holder { case video, music }

    private static var owners: [Holder: Set<ObjectIdentifier>] = [:]

    static func acquire(_ holder: Holder, by owner: AnyObject) {
        owners[holder, default: []].insert(ObjectIdentifier(owner))
        apply()
    }

    static func release(_ holder: Holder, by owner: AnyObject) {
        owners[holder]?.remove(ObjectIdentifier(owner))
        apply()
    }

    private static func held(_ holder: Holder) -> Bool { !(owners[holder]?.isEmpty ?? true) }

    private static func apply() {
        let session = AVAudioSession.sharedInstance()
        let video = held(.video)
        if !video, !held(.music) {
            do { try session.setActive(false, options: .notifyOthersOnDeactivation) } catch {
                Log.player.error("audio session deactivation failed: \(String(describing: error), privacy: .public)")
            }
            SoundManager.useAmbientSession()
            return
        }
        do {
            try session.setCategory(.playback, mode: video ? .moviePlayback : .default)
            try session.setActive(true)
        } catch {
            Log.player.error("audio session change failed: \(String(describing: error), privacy: .public)")
        }
    }
}
