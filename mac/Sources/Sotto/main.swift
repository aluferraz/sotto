import AppKit
import Combine
import SottoCore

// A dead engine must surface as a write error, not kill the app.
signal(SIGPIPE, SIG_IGN)

/// `Sotto --transcribe clip.wav [--cleanup smart|light|verbatim] [--language English] [--model ID]`
/// runs the same engine and post-processing as the app, without the UI.
func runCommandLine(arguments: [String]) -> Never {
    func value(_ flag: String) -> String? {
        guard let i = arguments.firstIndex(of: flag), i + 1 < arguments.count else { return nil }
        return arguments[i + 1]
    }
    let path = value("--transcribe")!
    let cleanup = CleanupLevel(rawValue: value("--cleanup") ?? "smart") ?? .smart
    let language = value("--language") ?? "English"
    let model = value("--model") ?? SettingsData.model8bit

    let samples: [Float]
    do {
        samples = try AudioRecorder.load(file: URL(fileURLWithPath: path))
    } catch {
        FileHandle.standardError.write("Could not read \(path): \(error)\n".data(using: .utf8)!)
        exit(2)
    }

    // Same gate as the app: silence never reaches the model.
    let hasSpeech = samples.withUnsafeBufferPointer { SpeechGate.containsSpeech(frameRMS: SpeechGate.frames(of: $0)) }
    if !hasSpeech && !arguments.contains("--no-gate") {
        print(String(format: "audio    %.2f s", Double(samples.count) / AudioRecorder.sampleRate))
        print("gate     no speech detected; nothing sent to the model")
        exit(0)
    }

    let engine = Engine()
    var sent = false
    let started = Date()
    let watcher = engine.$state.sink { state in
        switch state {
        case .failed(let why):
            FileHandle.standardError.write("Engine failed: \(why)\n".data(using: .utf8)!)
            exit(1)
        case .ready(let name, let detail) where !sent:
            sent = true
            print(String(format: "engine   %@ (%@), up after %.2f s", name, detail, Date().timeIntervalSince(started)))
            let asked = Date()
            engine.transcribe(samples: samples, language: language, cleanup: cleanup.rawValue, vocabulary: []) { result in
                switch result {
                case .failure(let error):
                    FileHandle.standardError.write("Transcription failed: \(error)\n".data(using: .utf8)!)
                    exit(1)
                case .success(let t):
                    let final = PostProcessor.process(t.text, options: .init(cleanup: cleanup, tone: .formal))
                    print(String(format: "audio    %.2f s", t.audioSeconds))
                    print(String(format: "timing   asr %.3f s · cleanup %.3f s · round trip %.3f s",
                                 t.asrSeconds, t.cleanupSeconds, Date().timeIntervalSince(asked)))
                    print("raw      \(t.raw)")
                    print("text     \(final)")
                    if !t.note.isEmpty { print("note     \(t.note)") }
                    engine.stop()
                    exit(0)
                }
            }
        default:
            break
        }
    }
    engine.start(model: model)
    withExtendedLifetime(watcher) { RunLoop.main.run() }
    exit(0)
}

if CommandLine.arguments.contains("--transcribe") {
    runCommandLine(arguments: CommandLine.arguments)
}

/// `Sotto --mic-check [seconds]` runs the live capture path and prints statistics only.
/// Nothing is transcribed or stored.
func runMicCheck(seconds: Double) -> Never {
    guard AudioRecorder.microphoneStatus == .authorized else {
        print("microphone permission: not granted to this process")
        exit(1)
    }
    let recorder = AudioRecorder()
    var levelCount = 0
    var loudest: Float = 0
    recorder.onLevel = { level in
        levelCount += 1
        loudest = max(loudest, level)
    }
    do {
        try recorder.start()
    } catch {
        print("could not start the microphone: \(error)")
        exit(1)
    }
    let began = Date()
    RunLoop.main.run(until: began.addingTimeInterval(seconds))
    let elapsed = Date().timeIntervalSince(began)
    let (samples, containsSpeech) = recorder.stop()
    let rms = (samples.reduce(Float(0)) { $0 + $1 * $1 } / Float(max(samples.count, 1))).squareRoot()
    print(String(format: "captured   %d samples in %.2f s = %.0f Hz (target 16000)", samples.count, elapsed, Double(samples.count) / elapsed))
    print(String(format: "loudness   overall %.1f dBFS, %d waveform updates (%.0f per second), peak bar %.2f",
                 20 * log10(max(rms, 1e-6)), levelCount, Double(levelCount) / elapsed, loudest))
    let stats = recorder.lastStats
    print(String(format: "gate       room %.1f dBFS, %d frames above the room, %d clearly loud (10 needed): %@",
                 20 * log10(max(stats.floor, 1e-6)), stats.activeFrames, stats.loudFrames,
                 containsSpeech ? "speech detected" : "no speech detected"))
    exit(0)
}

if let i = CommandLine.arguments.firstIndex(of: "--mic-check") {
    let seconds = i + 1 < CommandLine.arguments.count ? Double(CommandLine.arguments[i + 1]) ?? 2 : 2
    runMicCheck(seconds: seconds)
}

if let i = CommandLine.arguments.firstIndex(of: "--snapshot"), i + 1 < CommandLine.arguments.count {
    Snapshot.run(directory: CommandLine.arguments[i + 1])
}

// One instance only: two would both paste.
if let bundleID = Bundle.main.bundleIdentifier,
   NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).count > 1 {
    exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(SettingsStore.shared.data.showDockIcon ? .regular : .accessory)
app.run()
