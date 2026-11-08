import AVFoundation

/// The two stems of a track mixed through AVAudioEngine: the instrumental at full level, the vocals at
/// the level the singer picked. They start on one host time, so they stay in step with each other.
@MainActor final class KaraokeMixer {
    enum Kind: String, CaseIterable { case instrumental, vocals }

    private let engine = AVAudioEngine()
    private var nodes: [Kind: AVAudioPlayerNode] = [:]
    private var files: [Kind: AVAudioFile] = [:]
    private var folder: URL?
    private var origin = 0.0
    private(set) var playing = false

    var isLoaded: Bool { files.count == Kind.allCases.count }

    func setLevel(_ kind: Kind, _ level: Float) { nodes[kind]?.volume = max(0, min(1, level)) }

    /// Downloads the stems; `url` names where a kind is served. False when one cannot be fetched or decoded.
    func load(_ url: (Kind) -> URL?) async -> Bool {
        stop()
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("karaoke-\(UUID().uuidString)")
        guard (try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)) != nil else { return false }
        folder = dir
        for kind in Kind.allCases {
            guard let source = url(kind), let (tmp, response) = try? await URLSession.shared.download(from: source),
                  (response as? HTTPURLResponse)?.statusCode == 200 else { return false }
            let file = dir.appendingPathComponent("\(kind.rawValue).ogg")
            guard (try? FileManager.default.moveItem(at: tmp, to: file)) != nil, let audio = try? AVAudioFile(forReading: file) else { return false }
            let node = AVAudioPlayerNode()
            engine.attach(node)
            engine.connect(node, to: engine.mainMixerNode, format: audio.processingFormat)
            nodes[kind] = node
            files[kind] = audio
        }
        engine.prepare()
        return true
    }

    /// Where the stems are, in seconds, while they play.
    var position: Double {
        guard playing, let node = nodes[.instrumental], let t = node.lastRenderTime, let p = node.playerTime(forNodeTime: t) else { return origin }
        return origin + Double(p.sampleTime) / p.sampleRate
    }

    func start(at seconds: Double) {
        guard isLoaded else { return }
        pause()
        origin = seconds
        guard (try? engine.start()) != nil else { return }
        let when = AVAudioTime(hostTime: mach_absolute_time() + AVAudioTime.hostTime(forSeconds: 0.1))
        for (kind, node) in nodes {
            guard let file = files[kind] else { continue }
            let rate = file.processingFormat.sampleRate
            let from = AVAudioFramePosition(max(0, seconds) * rate)
            guard from < file.length else { continue }
            node.scheduleSegment(file, startingFrame: from, frameCount: AVAudioFrameCount(file.length - from), at: nil)
            node.play(at: when)
        }
        playing = true
    }

    func pause() {
        origin = position
        for node in nodes.values { node.stop() }
        engine.pause()
        playing = false
    }

    func stop() {
        for node in nodes.values { node.stop() }
        engine.stop()
        for node in nodes.values { engine.detach(node) }
        nodes = [:]
        files = [:]
        playing = false
        if let folder { try? FileManager.default.removeItem(at: folder) }
        folder = nil
    }
}
