import AppKit
import AVFoundation
import SottoCore

/// Connects the pieces: key events drive `TriggerMachine`, whose actions start
/// and stop the recorder, send audio to the engine and paste the result.
final class DictationController: ObservableObject {
    enum Phase: Equatable {
        case idle
        case recording(handsFree: Bool)
        case processing
        case notice(String, isError: Bool)
    }

    static let barCount = 22

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var levels = [Float](repeating: 0, count: DictationController.barCount)

    private let settings: SettingsStore
    private let engine: Engine
    private let history: HistoryStore
    private let recorder = AudioRecorder()

    private var machine = TriggerMachine()
    private var tapTimer: Timer?
    private var limitTimer: Timer?
    private var noticeTimer: Timer?
    private var generation = 0
    private var targetApp: NSRunningApplication?

    /// How long after a tap a second tap still switches to hands-free.
    private let doubleTapWindow: TimeInterval = 0.4
    private let maxRecording: TimeInterval = 300

    init(settings: SettingsStore, engine: Engine, history: HistoryStore) {
        self.settings = settings
        self.engine = engine
        self.history = history
        recorder.onLevel = { [weak self] level in
            guard let self, case .recording = self.phase else { return }
            self.levels.removeFirst()
            self.levels.append(level)
        }
    }

    /// Puts the controller in a given visual state for `--snapshot`.
    func preview(phase: Phase, levels: [Float]) {
        self.levels = levels
        self.phase = phase
    }

    // MARK: Key events

    /// Returns true when the key must not reach the focused app (only ever Escape).
    func handle(_ event: HotkeyMonitor.Event) -> Bool {
        switch event {
        case .down: return feed(.keyDown)
        case .up: return feed(.keyUp)
        case .escape: return feed(.escape)
        case .otherKey: return feed(.otherKey)
        }
    }

    @discardableResult
    private func feed(_ input: TriggerMachine.Input) -> Bool {
        var swallow = false
        for action in machine.handle(input, at: ProcessInfo.processInfo.systemUptime) {
            switch action {
            case .startRecording:
                if !startRecording() { machine.reset() }
            case .finishRecording:
                finishRecording()
            case .discardRecording(let quiet):
                _ = stopRecording()
                if quiet { phase = .idle } else { show("Cancelled", isError: false) }
            case .abandonProcessing:
                generation += 1
                show("Cancelled", isError: false)
            case .startTapWindow:
                tapTimer = Timer.scheduledTimer(withTimeInterval: doubleTapWindow, repeats: false) { [weak self] _ in
                    self?.feed(.tapWindowExpired)
                }
            case .stopTapWindow:
                tapTimer?.invalidate()
            case .enteredHandsFree:
                phase = .recording(handsFree: true)
            case .swallowKey:
                swallow = true
            }
        }
        return swallow
    }

    // MARK: Recording

    private func startRecording() -> Bool {
        noticeTimer?.invalidate()

        switch AudioRecorder.microphoneStatus {
        case .authorized:
            break
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { _ in }
            show("Allow the microphone, then try again", isError: true)
            return false
        default:
            show("Microphone access is off — see Settings", isError: true)
            return false
        }
        guard engine.state.isUsable else {
            show("Engine is not running — see Settings", isError: true)
            return false
        }
        do {
            try recorder.start()
        } catch {
            show("Microphone error: \(error)", isError: true)
            return false
        }

        targetApp = NSWorkspace.shared.frontmostApplication
        levels = [Float](repeating: 0, count: Self.barCount)
        phase = .recording(handsFree: false)
        playSound("Tink")
        limitTimer = Timer.scheduledTimer(withTimeInterval: maxRecording, repeats: false) { [weak self] _ in
            self?.feed(.limitReached)
        }
        return true
    }

    private func stopRecording() -> (samples: [Float], containsSpeech: Bool) {
        tapTimer?.invalidate()
        limitTimer?.invalidate()
        return recorder.stop()
    }

    private func finishRecording() {
        let (samples, containsSpeech) = stopRecording()
        let seconds = Double(samples.count) / AudioRecorder.sampleRate
        // Silence must never reach the model: it would invent a sentence.
        guard seconds >= 0.4, containsSpeech else {
            feed(.processingEnded)
            show("Didn't catch that", isError: false)
            return
        }

        generation += 1
        let request = generation
        let started = Date()
        let config = settings.data
        let app = targetApp
        phase = .processing

        engine.transcribe(
            samples: samples,
            language: config.language,
            cleanup: config.cleanup.rawValue,
            vocabulary: config.spellingHints
        ) { [weak self] result in
            // A stale generation means the user pressed Escape while this was running.
            guard let self, request == self.generation else { return }
            self.feed(.processingEnded)
            switch result {
            case .failure(let error):
                self.show(error.description, isError: true)
            case .success(let transcript):
                self.deliver(transcript, config: config, app: app, started: started)
            }
        }
    }

    // MARK: Delivery

    private func deliver(_ transcript: Transcript, config: SettingsData, app: NSRunningApplication?, started: Date) {
        let tone = config.tone(forBundleID: app?.bundleIdentifier)
        let processed = PostProcessor.process(
            transcript.text,
            options: .init(cleanup: config.cleanup, tone: tone, replacements: config.replacements, snippets: config.snippets))
        guard !processed.isEmpty else {
            show("Didn't catch that", isError: false)
            return
        }

        let fitted = PostProcessor.fit(processed, after: TextInserter.textBeforeCursor(), protectedTerms: config.spellingHints)
        let pasted = TextInserter.paste(fitted, targetBundleID: app?.bundleIdentifier, restoreClipboard: config.restoreClipboard)

        if config.keepHistory {
            history.add(HistoryEntry(
                date: Date(),
                app: app?.localizedName ?? "",
                raw: transcript.raw,
                text: processed,
                audioSeconds: transcript.audioSeconds,
                processingSeconds: Date().timeIntervalSince(started)))
        }

        if pasted {
            playSound("Pop")
            phase = .idle
        } else {
            show("Copied — press ⌘V (grant Accessibility to paste automatically)", isError: false, seconds: 4)
        }
    }

    private func show(_ message: String, isError: Bool, seconds: TimeInterval = 1.8) {
        phase = .notice(message, isError: isError)
        noticeTimer?.invalidate()
        noticeTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
            guard let self, case .notice = self.phase else { return }
            self.phase = .idle
        }
    }

    private func playSound(_ name: String) {
        guard settings.data.sounds, let sound = NSSound(named: NSSound.Name(name)) else { return }
        sound.volume = 0.35
        sound.play()
    }
}
