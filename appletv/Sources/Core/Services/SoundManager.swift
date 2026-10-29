import AVFoundation

/// Short click for tvOS focus changes. It rides the ambient session, or the player's `.playback` while a
/// video runs.
enum SoundManager {
    /// Mixes with background music and AirPlay audio; `.playback` covers a video from load to teardown only.
    static func useAmbientSession() {
        try? AVAudioSession.sharedInstance().setCategory(.ambient)
    }

    private static let player: AVAudioPlayer? = {
        guard let url = Bundle.main.url(forResource: "nav-click", withExtension: "wav") else { return nil }
        let p = try? AVAudioPlayer(contentsOf: url)
        p?.prepareToPlay()
        return p
    }()

    static func play() {
        guard let p = player else { return }
        p.currentTime = 0
        p.play()
    }
}
