import AVFoundation

/// Short click for tvOS focus changes. Ambient + mix-with-others so it never
/// interrupts video/audio playback. No on/off setting yet — P3 (UI phase)
/// wires this to focus changes and can gate it behind a Display toggle then.
enum SoundManager {
    private static let player: AVAudioPlayer? = {
        guard let url = Bundle.main.url(forResource: "nav-click", withExtension: "wav") else { return nil }
        try? AVAudioSession.sharedInstance().setCategory(.ambient, options: [.mixWithOthers])
        try? AVAudioSession.sharedInstance().setActive(true)
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
