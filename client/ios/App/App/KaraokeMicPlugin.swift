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

    private static let block = 1024
    private let engine = AVAudioEngine()
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
        input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(Self.block), format: format) { [weak self] buffer, _ in
            self?.push(buffer)
        }
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            call.reject("unavailable")
            return
        }
        call.resolve(["sampleRate": format.sampleRate, "echoCancelled": echoCancelled])
    }

    private func push(_ buffer: AVAudioPCMBuffer) {
        guard let channel = buffer.floatChannelData?[0] else { return }
        for i in 0..<Int(buffer.frameLength) {
            samples.append(Int16(max(-1, min(1, channel[i])) * 32767))
            if samples.count == Self.block {
                let data = samples.withUnsafeBufferPointer { Data(buffer: $0) }
                notifyListeners("block", data: ["data": data.base64EncodedString()])
                samples.removeAll(keepingCapacity: true)
            }
        }
    }

    private func close() {
        guard engine.isRunning else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        try? engine.inputNode.setVoiceProcessingEnabled(false)
        samples.removeAll()
        // Back to the plain playback session: a mixable one loses the lock screen controls.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
    }
}
