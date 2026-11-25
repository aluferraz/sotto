import AVFoundation
import SottoCore

/// Captures a microphone as 16 kHz mono float samples, the format LFM3-Audio's
/// encoder expects.
///
/// The system's input device is read with AVAudioEngine. A microphone picked in Settings is
/// read with a capture session instead: an audio engine keeps the format of the system's
/// device after being pointed at another one, and then delivers nothing when the two differ.
final class AudioRecorder: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
    static let sampleRate: Double = 16_000

    /// Called on the main queue with a 0...1 loudness for the waveform.
    var onLevel: ((Float) -> Void)?

    /// True when the last recording wanted a particular microphone that was not connected,
    /// and used the system's input instead.
    private(set) var usedSystemInputInstead = false

    private var engine: AVAudioEngine?
    private var session: AVCaptureSession?
    private let captureQueue = DispatchQueue(label: "dev.sotto.capture")
    private var samples: [Float] = []
    private var frameRMS: [Float] = []
    /// How many of `samples` have been measured into `frameRMS`.
    private var measured = 0
    private let lock = NSLock()

    /// 20 ms: the window the speech gate and the waveform work in.
    private static let frameSize = 320

    private static let targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false)!

    static var microphoneStatus: AVAuthorizationStatus {
        AVCaptureDevice.authorizationStatus(for: .audio)
    }

    /// `microphoneUID` picks a device (see `Microphones`); empty means the system's input.
    func start(microphoneUID: String = "") throws {
        lock.lock()
        samples.removeAll(keepingCapacity: true)
        frameRMS.removeAll(keepingCapacity: true)
        measured = 0
        lock.unlock()

        usedSystemInputInstead = false
        if !microphoneUID.isEmpty {
            if let device = AVCaptureDevice(uniqueID: microphoneUID) {
                try startCapture(from: device)
                return
            }
            usedSystemInputInstead = true
        }
        try startEngine()
    }

    /// The system's input device.
    private func startEngine() throws {
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
            self.take(UnsafeBufferPointer(start: channel, count: Int(out.frameLength)))
        }

        engine.prepare()
        try engine.start()
        self.engine = engine
    }

    /// One particular microphone. The capture session converts to 16 kHz mono floats itself.
    private func startCapture(from device: AVCaptureDevice) throws {
        let session = AVCaptureSession()
        let input: AVCaptureDeviceInput
        do {
            input = try AVCaptureDeviceInput(device: device)
        } catch {
            throw EngineError(description: "\(device.localizedName) could not be opened: \(error.localizedDescription)")
        }
        let output = AVCaptureAudioDataOutput()
        output.audioSettings = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: Self.sampleRate,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsNonInterleaved: false,
            AVLinearPCMIsBigEndianKey: false,
        ]
        output.setSampleBufferDelegate(self, queue: captureQueue)
        guard session.canAddInput(input), session.canAddOutput(output) else {
            throw EngineError(description: "\(device.localizedName) cannot be recorded from.")
        }
        session.addInput(input)
        session.addOutput(output)
        session.startRunning()
        guard session.isRunning else {
            throw EngineError(description: "\(device.localizedName) did not start.")
        }
        self.session = session
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput buffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let block = CMSampleBufferGetDataBuffer(buffer) else { return }
        var length = 0
        var bytes: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &bytes) == noErr,
              let bytes else { return }
        let count = length / MemoryLayout<Float>.size
        bytes.withMemoryRebound(to: Float.self, capacity: count) { floats in
            take(UnsafeBufferPointer(start: floats, count: count))
        }
    }

    /// Adds captured samples, and measures loudness in 20 ms frames, whatever size the
    /// buffers arrive in (10 ms from a capture session, 100 ms from an audio engine), so the
    /// speech gate and the waveform both see fine detail.
    private func take(_ chunk: UnsafeBufferPointer<Float>) {
        var fresh: [Float] = []
        lock.lock()
        samples.append(contentsOf: chunk)
        samples.withUnsafeBufferPointer { all in
            while all.count - measured >= Self.frameSize {
                let frame = UnsafeBufferPointer(rebasing: all[measured..<(measured + Self.frameSize)])
                fresh.append(contentsOf: SpeechGate.frames(of: frame, size: Self.frameSize))
                measured += Self.frameSize
            }
        }
        frameRMS.append(contentsOf: fresh)
        lock.unlock()

        for (i, rms) in fresh.enumerated() {
            // -55 dBFS (room noise) ... -10 dBFS (loud speech) mapped to 0...1
            let db = 20 * log10(max(rms, 1e-6))
            let level = min(1, max(0, (db + 55) / 45))
            // Spread the frames of one buffer over the time they cover, so the bars move smoothly.
            DispatchQueue.main.asyncAfter(deadline: .now() + Double(i) * 0.02) { self.onLevel?(level) }
        }
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
        if let session {
            session.stopRunning()
            self.session = nil
            // Let a buffer that is being delivered right now finish before the samples are read.
            captureQueue.sync {}
        }
        lock.lock()
        defer { lock.unlock() }
        lastStats = SpeechGate.analyze(frameRMS: frameRMS)
        let result = (samples, lastStats.containsSpeech)
        samples = []
        frameRMS = []
        return result
    }

    var isRunning: Bool { engine != nil || session != nil }

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
