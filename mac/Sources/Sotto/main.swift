import AppKit
import Combine
import SottoCore

// A dead engine must surface as a write error, not kill the app.
signal(SIGPIPE, SIG_IGN)

/// `Sotto --transcribe clip.wav [--cleanup smart|light|verbatim] [--language English] [--model ID]`
/// runs the same engine and post-processing as the app, without the UI.
///
/// `--api URL --api-model NAME [--api-cleanup-model NAME]` sends the clip to an OpenAI-compatible
/// API instead; the key, if the API wants one, is read from the SOTTO_API_KEY environment variable.
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

    func report(_ t: Transcript, since asked: Date) {
        let final = PostProcessor.process(t.text, options: .init(cleanup: cleanup, tone: .formal))
        print(String(format: "audio    %.2f s", t.audioSeconds))
        print(String(format: "timing   asr %.3f s · cleanup %.3f s · round trip %.3f s",
                     t.asrSeconds, t.cleanupSeconds, Date().timeIntervalSince(asked)))
        print("raw      \(t.raw)")
        print("text     \(final)")
        if !t.note.isEmpty { print("note     \(t.note)") }
    }

    if let address = value("--api") {
        let config = CloudConfig(
            baseURL: address, apiKey: ProcessInfo.processInfo.environment["SOTTO_API_KEY"] ?? "",
            model: value("--api-model") ?? "", cleanupModel: value("--api-cleanup-model") ?? "")
        let asked = Date()
        CloudEngine.transcribe(samples: samples, config: config, language: language, smart: cleanup == .smart, vocabulary: []) { result in
            switch result {
            case .failure(let error):
                FileHandle.standardError.write("Transcription failed: \(error)\n".data(using: .utf8)!)
                exit(1)
            case .success(let t):
                print("engine   \(config.model) at \(address)")
                report(t, since: asked)
                exit(0)
            }
        }
        RunLoop.main.run()
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
                    report(t, since: asked)
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

/// `Sotto --mic-check [seconds] [--microphone NAME]` runs the live capture path and prints
/// statistics only. Nothing is transcribed or stored. NAME is a microphone's name or part of it;
/// without it the microphone chosen in Settings is used.
func runMicCheck(seconds: Double, microphone: String?) -> Never {
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
    var uid = SettingsStore.shared.data.microphoneUID
    if let microphone {
        guard let match = Microphones.connected().first(where: { $0.name.localizedCaseInsensitiveContains(microphone) }) else {
            print("no connected microphone is called \(microphone)")
            exit(1)
        }
        uid = match.uid
    }
    let name = Microphones.connected().first { $0.uid == uid }?.name ?? "the system default"
    do {
        try recorder.start(microphoneUID: uid)
    } catch {
        print("could not start the microphone: \(error)")
        exit(1)
    }
    print("microphone \(recorder.usedSystemInputInstead ? "the system default (the chosen one is not connected)" : name)")
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
    let named = CommandLine.arguments.firstIndex(of: "--microphone").flatMap { j in
        j + 1 < CommandLine.arguments.count ? CommandLine.arguments[j + 1] : nil
    }
    runMicCheck(seconds: seconds, microphone: named)
}

// `Sotto --keychain-check` stores, reads back and removes a throwaway item, to see that the
// keychain accepts this build. It never touches the real key.
if CommandLine.arguments.contains("--keychain-check") {
    let account = "self-test-\(ProcessInfo.processInfo.processIdentifier)"
    let saved = ApiKeyStore(account: account).save("sk-self-test")
    let fresh = ApiKeyStore(account: account)
    fresh.load()
    let read = fresh.key == "sk-self-test"
    let removed = fresh.save("")
    let gone = ApiKeyStore(account: account)
    gone.load()
    print("keychain   save \(saved ? "ok" : "refused"), read back \(read ? "ok" : "wrong"), remove \(removed && gone.key.isEmpty ? "ok" : "failed")")
    exit(saved && read && removed && gone.key.isEmpty ? 0 : 1)
}

if CommandLine.arguments.contains("--list-microphones") {
    for microphone in Microphones.connected() { print(microphone.name) }
    exit(0)
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
