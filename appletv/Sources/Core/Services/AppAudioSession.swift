import AVFoundation
import os

/// The one owner of the app's audio session: `.playback` while a video or the music player holds it, the
/// mixable `.ambient` one of the focus click once nobody does, so one releasing never cuts the other.
@MainActor
enum AppAudioSession {
    enum Holder { case video, music }

    private static var holders: Set<Holder> = []

    static func acquire(_ holder: Holder) {
        holders.insert(holder)
        apply()
    }

    static func release(_ holder: Holder) {
        holders.remove(holder)
        apply()
    }

    private static func apply() {
        let session = AVAudioSession.sharedInstance()
        do {
            if holders.isEmpty {
                try session.setActive(false, options: .notifyOthersOnDeactivation)
                SoundManager.useAmbientSession()
            } else {
                try session.setCategory(.playback, mode: holders.contains(.video) ? .moviePlayback : .default)
                try session.setActive(true)
            }
        } catch {
            Log.player.error("audio session change failed: \(String(describing: error), privacy: .public)")
        }
    }
}
