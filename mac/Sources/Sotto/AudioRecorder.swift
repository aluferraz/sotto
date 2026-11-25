import AVFoundation
import SottoCore

/// Captures the default microphone as 16 kHz mono float samples, the format
/// LFM3-Audio's encoder expects.
final class AudioRecorder {
    static let sampleRate: Double = 16_000

    /// Called on the main queue with a 0...1 loudness for the waveform.
    var onLevel: ((Float) -> Void)?

    private var engine: AVAudioEngine?
    private var samples: [Float] = []
    private var frameRMS: [Float] = []
    private let lock = NSLock()

    private static let targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false)!

    static var microphoneStatus: AVAuthorizationStatus {
        AVCaptureDevice.authorizationStatus(for: .audio)
    }

    func start() throws {
        // A fresh engine each time picks up whatever input device is current (AirPods, a new mic).
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw EngineError(description: "No microphone is available.")
        }
        guard let converter = AVAudioConverter(from: format, to: Self.targetFormat) else {
            throw EngineError(description: "Unsupported microphone format.")
        }

        lock.lock()
        samples.removeAll(keepingCapacity: true)
        frameRMS.removeAll(keepingCapacity: true)
        lock.unlock()

        let ratio = Self.sampleRate / format.sampleRate
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
            guard let out = AVAudioPCMBuffer(pcmFormat: Self.targetFormat, frameCapacity: capacity) else { return }
            var fed = false
            var error: NSError?
            converter.convert(to: out, error: &error) { _, status in
                if fed {
                    status.pointee = .noDataNow
                    return nil
                }
                fed = true
                status.pointee = .haveData
                return buffer
            }
            guard error == nil, out.frameLength > 0, let channel = out.floatChannelData?[0] else { return }
            let chunk = UnsafeBufferPointer(start: channel, count: Int(out.frameLength))

            // The tap may deliver 100 ms at a time; measure loudness in 20 ms frames
            // so the speech gate and the waveform both see fine detail.
            let frames = SpeechGate.frames(of: chunk)

            self.lock.lock()
            self.samples.append(contentsOf: chunk)
            self.frameRMS.append(contentsOf: frames)
            self.lock.unlock()

            for (i, rms) in frames.enumerated() {
                // -55 dBFS (room noise) ... -10 dBFS (loud speech) mapped to 0...1
                let db = 20 * log10(max(rms, 1e-6))
                let level = min(1, max(0, (db + 55) / 45))
                // Spread the frames of one buffer over the time they cover, so the bars move smoothly.
                DispatchQueue.main.asyncAfter(deadline: .now() + Double(i) * 0.02) { self.onLevel?(level) }
            }
        }

        engine.prepare()
        try engine.start()
        self.engine = engine
    }

    /// Loudness statistics of the last recording, for `--mic-check`.
    private(set) var lastStats = SpeechGate.analyze(frameRMS: [])

    /// Stops capturing and returns the samples and whether anyone spoke.
    func stop() -> (samples: [Float], containsSpeech: Bool) {
        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
            self.engine = nil
        }
        lock.lock()
        defer { lock.unlock() }
        lastStats = SpeechGate.analyze(frameRMS: frameRMS)
        let result = (samples, lastStats.containsSpeech)
        samples = []
        frameRMS = []
        return result
    }

    var isRunning: Bool { engine != nil }

    /// Loads any audio file as 16 kHz mono floats (used by the command-line mode).
    static func load(file url: URL) throws -> [Float] {
        let file = try AVAudioFile(forReading: url)
        let format = file.processingFormat
        guard let inBuffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(file.length)) else {
            throw EngineError(description: "Could not allocate a buffer for \(url.lastPathComponent).")
        }
        try file.read(into: inBuffer)
        guard let converter = AVAudioConverter(from: format, to: targetFormat) else {
            throw EngineError(description: "Unsupported audio format in \(url.lastPathComponent).")
        }
        let capacity = AVAudioFrameCount(Double(inBuffer.frameLength) * sampleRate / format.sampleRate) + 1024
        guard let out = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else {
            throw EngineError(description: "Could not allocate the output buffer.")
        }
        var fed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if fed {
                status.pointee = .endOfStream
                return nil
            }
            fed = true
            status.pointee = .haveData
            return inBuffer
        }
        if let error { throw error }
        guard let channel = out.floatChannelData?[0] else { return [] }
        return Array(UnsafeBufferPointer(start: channel, count: Int(out.frameLength)))
    }
}
