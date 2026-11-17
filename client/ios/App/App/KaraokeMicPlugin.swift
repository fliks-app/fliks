import AVFoundation
import Capacitor

/// Karaoke microphone captured in the app's own audio session: WebKit's capture opens a second session that interrupts the music.
@objc(KaraokeMicPlugin)
public class KaraokeMicPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "KaraokeMicPlugin"
    public let jsName = "KaraokeMic"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
    ]

    private static let block = 512
    private let engine = AVAudioEngine()
    private let queue = DispatchQueue(label: "karaoke.mic")
    private var sink: AVAudioSinkNode?
    private var samples = [Int16]()

    @objc func start(_ call: CAPPluginCall) {
        AVAudioSession.sharedInstance().requestRecordPermission { granted in
            DispatchQueue.main.async { granted ? self.open(call) : call.reject("denied") }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.close()
            call.resolve()
        }
    }

    private func open(_ call: CAPPluginCall) {
        close()
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .default, options: [.mixWithOthers, .defaultToSpeaker, .allowBluetoothA2DP, .allowAirPlay])
            try session.setPreferredIOBufferDuration(0.005)
            try session.setActive(true)
        } catch {
            call.reject("unavailable")
            return
        }
        let input = engine.inputNode
        // Voice processing is the platform echo canceller; the music keeps its level.
        let echoCancelled = (try? input.setVoiceProcessingEnabled(true)) != nil
        if #available(iOS 17.0, *), echoCancelled {
            input.voiceProcessingOtherAudioDuckingConfiguration = AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
        }
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            call.reject("unavailable")
            return
        }
        // A sink node is called once per input cycle; a tap delivers its buffers in coarser, delayed chunks.
        let sink = AVAudioSinkNode { [weak self] _, frames, list in
            let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: list))
            guard let data = buffers.first?.mData?.assumingMemoryBound(to: Float.self) else { return noErr }
            let chunk = Array(UnsafeBufferPointer(start: data, count: Int(frames)))
            self?.queue.async { self?.push(chunk) }
            return noErr
        }
        engine.attach(sink)
        engine.connect(input, to: sink, format: format)
        self.sink = sink
        do {
            try engine.start()
        } catch {
            engine.detach(sink)
            self.sink = nil
            call.reject("unavailable")
            return
        }
        // Voice processing moves the output to the receiver; the music stays on the loudspeaker.
        try? session.overrideOutputAudioPort(.speaker)
        call.resolve(["sampleRate": format.sampleRate, "echoCancelled": echoCancelled])
    }

    private func push(_ chunk: [Float]) {
        for value in chunk {
            samples.append(Int16(max(-1, min(1, value)) * 32767))
            if samples.count == Self.block {
                let data = samples.withUnsafeBufferPointer { Data(buffer: $0) }
                notifyListeners("block", data: ["data": data.base64EncodedString()])
                samples.removeAll(keepingCapacity: true)
            }
        }
    }

    private func close() {
        guard engine.isRunning else { return }
        engine.stop()
        if let sink { engine.detach(sink) }
        sink = nil
        try? engine.inputNode.setVoiceProcessingEnabled(false)
        queue.async { self.samples.removeAll() }
        // Back to the plain playback session: a mixable one loses the lock screen controls.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
    }
}
