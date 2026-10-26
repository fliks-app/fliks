import AVFoundation

/// Short click for tvOS focus changes. It rides whatever session is current (the player's `.playback`
/// while a video runs), so it never claims one of its own.
enum SoundManager {
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
